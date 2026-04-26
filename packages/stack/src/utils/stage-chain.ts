/**
 * Stage Chain Runner
 *
 * Sits on top of the DAG runner and executes the four-stage chain:
 *   dev → staging → prod
 *
 * Contract (from the architectural discussion):
 *   - Each stage is its own DAG. Within a stage, `Fix.requires` orders fixes
 *     and skip-propagation marks dependents as `skipped` on prereq failure.
 *   - Cross-stage gating is sequential-and-critical: if any fix in stage N
 *     ends up `failed` or `manual-critical`, stages N+1..end run with every
 *     fix auto-marked `skipped` and a shared reason "prior stage failed".
 *   - canReach() routing is NOT consulted. Everything executes on the dev
 *     machine; staging/prod scanfixes reach the server through the tunnel.
 *   - The tunnel lifecycle (open/close) is owned by runStageChain, not by
 *     individual scanfixes. When openTunnel throws, the whole stage is
 *     synthesised as `skipped` and the chain breaks.
 *
 * scan.ts / fix.ts / deploy.ts don't call this yet — individual scanfixes
 * are migrating to `requires` first. The stage chain becomes the default
 * runner once every staging/prod scanfix that exists today has been
 * audited to work over the tunnel instead of on the server.
 */

import type { Fix, FactiiiConfig, Stage } from '../types/index.js';
import { runFixDAG, type DAGResult, type FixOutcome, type FixStatus } from './dag-runner.js';
import {
  openTunnel as realOpenTunnel,
  closeTunnel as realCloseTunnel,
  type TunnelHandle,
} from './ssh-tunnel.js';
import { extractEnvironments } from './config-helpers.js';
import { findSshKeyForStage } from './ssh-helper.js';

/** Default stage order. Callers can narrow it but not reorder. */
export const STAGE_ORDER: Stage[] = ['dev', 'staging', 'prod'];

/** Stages that require an SSH tunnel be open during their DAG run. */
const REMOTE_STAGES: ReadonlySet<Stage> = new Set<Stage>(['staging', 'prod']);

export interface StageChainOptions {
  config: FactiiiConfig;
  rootDir: string;
  /** When false (default), scan only. True flips on fix application. */
  applyFixes?: boolean;
  /** Narrow the chain (e.g. ['dev', 'staging']). Must stay in STAGE_ORDER order. */
  stages?: Stage[];
  /** Called as each fix settles, inside its stage. */
  onOutcome?: (outcome: FixOutcome, fix: Fix, stage: Stage) => void;
  /** Called when a stage finishes; receives the whole DAG result. */
  onStageComplete?: (stage: Stage, result: DAGResult) => void;
  /**
   * Optional injectable tunnel functions. Production callers omit this and
   * get the real openTunnel/closeTunnel from utils/ssh-tunnel.ts. Unit tests
   * pass fakes so they don't need to monkey-patch the SSH module.
   */
  tunnel?: {
    openTunnel: typeof realOpenTunnel;
    closeTunnel: typeof realCloseTunnel;
  };
}

export interface StageChainResult {
  byStage: Map<Stage, DAGResult>;
  /** True once any stage produced a failed outcome — downstream stages are auto-skipped after that. */
  chainBroken: boolean;
  /** The stage that first broke the chain, if any. */
  firstFailedStage: Stage | null;
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
 * Execute the stage chain. Within each stage, fixes run as a DAG. Across
 * stages, a `failed` or `manual-critical` outcome breaks the chain — every
 * fix in subsequent stages is synthesized as `skipped`.
 *
 * For remote stages (staging, prod), runStageChain owns the tunnel
 * lifecycle: it calls openTunnel on stage entry (only if the stage has
 * fixes to run) and closeTunnel on exit, regardless of `applyFixes`. If
 * openTunnel throws, the entire stage skip-results with the tunnel error
 * in `reason` and the chain breaks.
 */
export async function runStageChain(fixes: Fix[], options: StageChainOptions): Promise<StageChainResult> {
  const stagesToRun = options.stages ?? STAGE_ORDER;
  const byStage = new Map<Stage, DAGResult>();
  let firstFailedStage: Stage | null = null;

  const openTunnel = options.tunnel?.openTunnel ?? realOpenTunnel;
  const closeTunnel = options.tunnel?.closeTunnel ?? realCloseTunnel;

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

    // Remote stage — open tunnel before running the DAG.
    let tunnelHandle: TunnelHandle | null = null;
    if (REMOTE_STAGES.has(stage)) {
      try {
        const envs = extractEnvironments(options.config);
        const envEntry = Object.entries(envs).find(
          ([name]) => name === stage || name.startsWith(stage + '_'),
        );
        if (!envEntry) {
          throw new Error('no ' + stage + ' environment in stack.yml');
        }
        const envConfig = envEntry[1];
        if (!envConfig.domain || envConfig.domain.toUpperCase().startsWith('EXAMPLE')) {
          throw new Error(stage + ' domain is still a placeholder');
        }
        const keyPath = findSshKeyForStage(stage, options.config.name);
        tunnelHandle = openTunnel(stage, envConfig, keyPath ?? null);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const skipResult = buildSkipResult(stageFixes, 'tunnel open failed: ' + msg);
        byStage.set(stage, skipResult);
        options.onStageComplete?.(stage, skipResult);
        firstFailedStage = stage;
        continue;
      }
    }

    try {
      const result = await runFixDAG(stageFixes, {
        config: options.config,
        rootDir: options.rootDir,
        applyFixes: options.applyFixes,
        onOutcome: options.onOutcome
          ? (o, f) => options.onOutcome!(o, f, stage)
          : undefined,
      });
      byStage.set(stage, result);
      options.onStageComplete?.(stage, result);

      if (stageIsBroken(result, stageFixes)) {
        firstFailedStage = stage;
      }
    } finally {
      if (tunnelHandle) {
        try { closeTunnel(tunnelHandle); } catch { /* best effort */ }
      }
    }
  }

  return {
    byStage,
    chainBroken: firstFailedStage !== null,
    firstFailedStage,
  };
}
