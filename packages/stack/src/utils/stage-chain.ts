/**
 * Stage Chain Runner
 *
 * Sits on top of the DAG runner and executes the four-stage chain:
 *   dev → secrets → staging → prod
 *
 * Contract (from the architectural discussion):
 *   - Each stage is its own DAG. Within a stage, `Fix.requires` orders fixes
 *     and skip-propagation marks dependents as `skipped` on prereq failure.
 *   - Cross-stage gating is sequential-and-critical: if any fix in stage N
 *     ends up `failed` or `manual-critical`, stages N+1..end run with every
 *     fix auto-marked `skipped` and a shared reason "prior stage failed".
 *   - Every staging fix (except the tunnel itself) implicitly `requires`
 *     `ssh-tunnel-staging`. Same rule for prod with `ssh-tunnel-prod`. That
 *     auto-injection happens here so individual scanfixes never hand-write
 *     the edge — drop a new staging/prod fix into the fixes[] array and the
 *     runner gates it on the tunnel for you.
 *   - canReach() routing is NOT consulted. Everything executes on the dev
 *     machine; staging/prod scanfixes reach the server through the tunnel.
 *
 * scan.ts / fix.ts / deploy.ts don't call this yet — individual scanfixes
 * are migrating to `requires` first. The stage chain becomes the default
 * runner once every staging/prod scanfix that exists today has been
 * audited to work over the tunnel instead of on the server.
 */

import type { Fix, FactiiiConfig, Stage } from '../types/index.js';
import { runFixDAG, type DAGResult, type FixOutcome, type FixStatus } from './dag-runner.js';

/** Default stage order. Callers can narrow it but not reorder. */
export const STAGE_ORDER: Stage[] = ['dev', 'secrets', 'staging', 'prod'];

/** The SSH tunnel fix id for each remote stage. */
export const TUNNEL_FIX_ID: Partial<Record<Stage, string>> = {
  staging: 'ssh-tunnel-staging',
  prod: 'ssh-tunnel-prod',
};

export interface StageChainOptions {
  config: FactiiiConfig;
  rootDir: string;
  /** When false (default), scan only. True flips on fix application. */
  applyFixes?: boolean;
  /** Narrow the chain (e.g. ['dev', 'secrets', 'staging']). Must stay in STAGE_ORDER order. */
  stages?: Stage[];
  /** Called as each fix settles, inside its stage. */
  onOutcome?: (outcome: FixOutcome, fix: Fix, stage: Stage) => void;
  /** Called when a stage finishes; receives the whole DAG result. */
  onStageComplete?: (stage: Stage, result: DAGResult) => void;
}

export interface StageChainResult {
  byStage: Map<Stage, DAGResult>;
  /** True once any stage produced a failed outcome — downstream stages are auto-skipped after that. */
  chainBroken: boolean;
  /** The stage that first broke the chain, if any. */
  firstFailedStage: Stage | null;
}

/**
 * Auto-inject the stage's SSH tunnel as a prereq on every non-tunnel fix
 * in that stage. Pure — does not mutate the input fixes.
 */
export function injectStageTunnelEdges(fixes: Fix[], stage: Stage): Fix[] {
  const tunnelId = TUNNEL_FIX_ID[stage];
  if (!tunnelId) return fixes;
  // Only inject when the tunnel scanfix actually exists in the set; otherwise
  // we'd silently wedge every staging fix on a missing prereq id.
  if (!fixes.some((f) => f.id === tunnelId)) return fixes;

  return fixes.map((f) => {
    if (f.id === tunnelId) return f;
    const existing = f.requires ?? [];
    if (existing.includes(tunnelId)) return f;
    return { ...f, requires: [...existing, tunnelId] };
  });
}

function stageIsBroken(result: DAGResult, fixes: Fix[]): boolean {
  if (result.hasFailures) return true;
  // A critical scan with no auto-fix (`status: 'manual'`) is also chain-breaking.
  const bySeverity = new Map(fixes.map((f) => [f.id, f.severity]));
  for (const o of result.outcomes.values()) {
    if (o.status === 'manual' && bySeverity.get(o.id) === 'critical') return true;
  }
  return false;
}

function buildSkipResult(fixes: Fix[], reason: string): DAGResult {
  const outcomes = new Map<string, FixOutcome>();
  for (const f of fixes) {
    outcomes.set(f.id, {
      id: f.id,
      status: 'skipped' as FixStatus,
      reason,
      issueDetected: false,
      durationMs: 0,
    });
  }
  return {
    outcomes,
    orderedIds: fixes.map((f) => f.id),
    hasFailures: false,
    hasSkipped: fixes.length > 0,
  };
}

/**
 * Execute the stage chain. Scans everything in `fixes`, partitioning by
 * `fix.stage`, and runs each stage's DAG in STAGE_ORDER. After a stage
 * breaks, subsequent stages aren't invoked — their fixes are synthesized
 * into a skip-result with a shared reason so the final report is uniform.
 */
export async function runStageChain(fixes: Fix[], options: StageChainOptions): Promise<StageChainResult> {
  const stagesToRun = options.stages ?? STAGE_ORDER;
  const byStage = new Map<Stage, DAGResult>();
  let firstFailedStage: Stage | null = null;

  for (const stage of stagesToRun) {
    const stageFixes = fixes.filter((f) => f.stage === stage);
    if (stageFixes.length === 0) {
      byStage.set(stage, buildSkipResult([], ''));
      continue;
    }

    if (firstFailedStage !== null) {
      byStage.set(
        stage,
        buildSkipResult(stageFixes, 'prior stage (' + firstFailedStage + ') failed'),
      );
      options.onStageComplete?.(stage, byStage.get(stage)!);
      continue;
    }

    const prepared = injectStageTunnelEdges(stageFixes, stage);
    const result = await runFixDAG(prepared, {
      config: options.config,
      rootDir: options.rootDir,
      applyFixes: options.applyFixes,
      onOutcome: options.onOutcome
        ? (o, f) => options.onOutcome!(o, f, stage)
        : undefined,
    });
    byStage.set(stage, result);
    options.onStageComplete?.(stage, result);

    if (stageIsBroken(result, prepared)) {
      firstFailedStage = stage;
    }
  }

  return {
    byStage,
    chainBroken: firstFailedStage !== null,
    firstFailedStage,
  };
}
