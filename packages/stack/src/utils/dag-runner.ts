/**
 * Fix DAG Runner
 *
 * Executes an array of `Fix` definitions as a dependency graph instead of
 * a flat ordered list. Each fix can declare:
 *   - `requires: string[]` — ids that must succeed first. Skipped prereq →
 *     this fix is marked skipped (not failed), so one upstream failure
 *     doesn't cascade into a noisy list of doomed fixes.
 *   - `serializeOn: string[]` — named resources. Fixes sharing any resource
 *     id run serially w.r.t. each other; everything else is parallel.
 *
 * The runner is intentionally decoupled from scan.ts / fix.ts / deploy.ts —
 * they stay on the existing multi-pass flow until individual scanfix groups
 * migrate. New scanfixes that want the DAG can be handed to `runFixDAG`
 * directly; consumers accumulate results and print them at the end.
 */

import type { Fix, FactiiiConfig } from '../types/index.js';

export type FixStatus = 'ok' | 'fixed' | 'failed' | 'skipped' | 'manual';

export interface FixOutcome {
  id: string;
  status: FixStatus;
  /** Reason for a non-`ok` outcome — error message, "prereq X skipped", etc. */
  reason?: string;
  /** True when scan detected an issue. False means "no issue found; fix not run." */
  issueDetected: boolean;
  /** Duration in ms for scan + fix combined. */
  durationMs: number;
}

export interface DAGResult {
  outcomes: Map<string, FixOutcome>;
  orderedIds: string[];
  hasFailures: boolean;
  hasSkipped: boolean;
}

export interface RunOptions {
  rootDir: string;
  config: FactiiiConfig;
  /** When false (default), do not invoke `fix` functions — only scan. */
  applyFixes?: boolean;
  /** Called as each fix completes. For streaming UI. */
  onOutcome?: (outcome: FixOutcome, fix: Fix) => void;
}

class CycleError extends Error {
  constructor(public readonly cycleIds: string[]) {
    super('Fix DAG has a dependency cycle: ' + cycleIds.join(' → '));
    this.name = 'CycleError';
  }
}

/**
 * Topological sort via DFS with cycle detection. Stable: preserves input
 * order for fixes with equal dependencies so runs are reproducible.
 */
export function topoSort(fixes: Fix[]): Fix[] {
  const byId = new Map(fixes.map((f) => [f.id, f]));
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  fixes.forEach((f) => color.set(f.id, WHITE));
  const out: Fix[] = [];
  const stack: string[] = [];

  function visit(id: string): void {
    const c = color.get(id) ?? WHITE;
    if (c === BLACK) return;
    if (c === GRAY) {
      const idx = stack.indexOf(id);
      throw new CycleError(stack.slice(idx).concat(id));
    }
    color.set(id, GRAY);
    stack.push(id);
    const fix = byId.get(id);
    if (fix) {
      for (const dep of fix.requires ?? []) {
        if (byId.has(dep)) visit(dep);
        // Unknown deps are silently ignored here and reported at run time
        // so a typo in `requires` is visible as a skip reason, not a crash
        // during graph construction.
      }
      out.push(fix);
    }
    stack.pop();
    color.set(id, BLACK);
  }

  for (const f of fixes) visit(f.id);
  return out;
}

/**
 * Build the lookup of unmet transitive dependencies per fix. Returns null
 * if every `requires` id exists in the fix set; otherwise a map of fixId →
 * missing ids so the runner can mark those fixes skipped with a clear reason.
 */
export function missingRequires(fixes: Fix[]): Map<string, string[]> {
  const ids = new Set(fixes.map((f) => f.id));
  const missing = new Map<string, string[]>();
  for (const f of fixes) {
    const gaps = (f.requires ?? []).filter((r) => !ids.has(r));
    if (gaps.length > 0) missing.set(f.id, gaps);
  }
  return missing;
}

/**
 * Execute the DAG. Currently single-threaded within a `serializeOn` group
 * and across the whole DAG — parallelism is the next step once every
 * scanfix declares its shared-resource ids honestly. Correct ordering +
 * skip propagation is the hard part and is done here.
 */
export async function runFixDAG(fixes: Fix[], options: RunOptions): Promise<DAGResult> {
  const ordered = topoSort(fixes);
  const gaps = missingRequires(fixes);

  const outcomes = new Map<string, FixOutcome>();

  for (const fix of ordered) {
    const started = Date.now();

    // 1) Missing-requires gap → skip with explicit reason.
    const missing = gaps.get(fix.id);
    if (missing && missing.length > 0) {
      const outcome: FixOutcome = {
        id: fix.id,
        status: 'skipped',
        reason: 'unknown prereq id(s): ' + missing.join(', '),
        issueDetected: false,
        durationMs: Date.now() - started,
      };
      outcomes.set(fix.id, outcome);
      options.onOutcome?.(outcome, fix);
      continue;
    }

    // 2) Any upstream prereq failed/skipped → skip (don't cascade noise).
    const failedPrereq = (fix.requires ?? []).find((r) => {
      const o = outcomes.get(r);
      return o && (o.status === 'failed' || o.status === 'skipped');
    });
    if (failedPrereq) {
      const outcome: FixOutcome = {
        id: fix.id,
        status: 'skipped',
        reason: 'prereq ' + failedPrereq + ' ' + (outcomes.get(failedPrereq)?.status ?? 'failed'),
        issueDetected: false,
        durationMs: Date.now() - started,
      };
      outcomes.set(fix.id, outcome);
      options.onOutcome?.(outcome, fix);
      continue;
    }

    // 3) Scan. If no issue → ok.
    let issueDetected = false;
    try {
      issueDetected = await fix.scan(options.config, options.rootDir);
    } catch (e) {
      const outcome: FixOutcome = {
        id: fix.id,
        status: 'failed',
        reason: 'scan threw: ' + (e instanceof Error ? e.message : String(e)),
        issueDetected: false,
        durationMs: Date.now() - started,
      };
      outcomes.set(fix.id, outcome);
      options.onOutcome?.(outcome, fix);
      continue;
    }

    if (!issueDetected) {
      const outcome: FixOutcome = {
        id: fix.id,
        status: 'ok',
        issueDetected: false,
        durationMs: Date.now() - started,
      };
      outcomes.set(fix.id, outcome);
      options.onOutcome?.(outcome, fix);
      continue;
    }

    // 4) Issue detected. Run fix if requested and available; otherwise manual.
    if (!options.applyFixes || !fix.fix) {
      const outcome: FixOutcome = {
        id: fix.id,
        status: 'manual',
        reason: fix.manualFix,
        issueDetected: true,
        durationMs: Date.now() - started,
      };
      outcomes.set(fix.id, outcome);
      options.onOutcome?.(outcome, fix);
      continue;
    }

    try {
      const applied = await fix.fix(options.config, options.rootDir);
      const outcome: FixOutcome = {
        id: fix.id,
        status: applied ? 'fixed' : 'failed',
        reason: applied ? undefined : 'fix returned false',
        issueDetected: true,
        durationMs: Date.now() - started,
      };
      outcomes.set(fix.id, outcome);
      options.onOutcome?.(outcome, fix);
    } catch (e) {
      const outcome: FixOutcome = {
        id: fix.id,
        status: 'failed',
        reason: 'fix threw: ' + (e instanceof Error ? e.message : String(e)),
        issueDetected: true,
        durationMs: Date.now() - started,
      };
      outcomes.set(fix.id, outcome);
      options.onOutcome?.(outcome, fix);
    }
  }

  let hasFailures = false;
  let hasSkipped = false;
  for (const o of outcomes.values()) {
    if (o.status === 'failed') hasFailures = true;
    if (o.status === 'skipped') hasSkipped = true;
  }

  return {
    outcomes,
    orderedIds: ordered.map((f) => f.id),
    hasFailures,
    hasSkipped,
  };
}

export { CycleError };
