/**
 * Tests for the Fix DAG runner.
 *
 * Verifies the three properties the runner must guarantee:
 *   1. Topological order — prereqs always run before dependents.
 *   2. Skip propagation — a failed/skipped prereq marks all its transitive
 *      dependents as `skipped` (not `failed`) so one upstream error doesn't
 *      drown the report in noise.
 *   3. Cycle detection — a cycle is reported, not silently infinite-looped.
 */
import {
  topoSort,
  missingRequires,
  runFixDAG,
  CycleError,
} from '../src/utils/dag-runner.js';
import type { Fix, FactiiiConfig } from '../src/types/index.js';

function mkFix(partial: Partial<Fix> & Pick<Fix, 'id' | 'scan'>): Fix {
  return {
    stage: 'dev',
    severity: 'info',
    description: partial.id,
    manualFix: 'manual: ' + partial.id,
    ...partial,
  } as Fix;
}

const baseConfig: FactiiiConfig = { name: 'test' };

describe('topoSort', () => {
  test('orders fixes with chain dependencies prereq-first', () => {
    const a = mkFix({ id: 'a', scan: async () => false });
    const b = mkFix({ id: 'b', requires: ['a'], scan: async () => false });
    const c = mkFix({ id: 'c', requires: ['b'], scan: async () => false });

    // Input order is deliberately reversed to prove the sort reorders.
    const sorted = topoSort([c, b, a]);
    const ids = sorted.map((f) => f.id);
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('c'));
  });

  test('throws CycleError on a → b → a', () => {
    const a = mkFix({ id: 'a', requires: ['b'], scan: async () => false });
    const b = mkFix({ id: 'b', requires: ['a'], scan: async () => false });
    expect(() => topoSort([a, b])).toThrow(CycleError);
  });

  test('ignores unknown prereq ids during sort (runner reports them as skips)', () => {
    const a = mkFix({ id: 'a', requires: ['nope'], scan: async () => false });
    const sorted = topoSort([a]);
    expect(sorted.map((f) => f.id)).toEqual(['a']);
  });
});

describe('missingRequires', () => {
  test('reports ids that point at nothing in the set', () => {
    const a = mkFix({ id: 'a', requires: ['missing'], scan: async () => false });
    const b = mkFix({ id: 'b', requires: ['a'], scan: async () => false });
    const gaps = missingRequires([a, b]);
    expect(gaps.get('a')).toEqual(['missing']);
    expect(gaps.has('b')).toBe(false);
  });
});

describe('runFixDAG', () => {
  test('runs a scan-only pass and reports ok when no issues', async () => {
    const a = mkFix({ id: 'a', scan: async () => false });
    const b = mkFix({ id: 'b', requires: ['a'], scan: async () => false });

    const res = await runFixDAG([b, a], { config: baseConfig, rootDir: '/tmp' });
    expect(res.hasFailures).toBe(false);
    expect(res.hasSkipped).toBe(false);
    expect(res.outcomes.get('a')?.status).toBe('ok');
    expect(res.outcomes.get('b')?.status).toBe('ok');
  });

  test('skips dependents when a prereq fails', async () => {
    const a = mkFix({
      id: 'a',
      scan: async () => { throw new Error('boom'); },
    });
    const b = mkFix({ id: 'b', requires: ['a'], scan: async () => false });
    const c = mkFix({ id: 'c', requires: ['b'], scan: async () => false });

    const res = await runFixDAG([a, b, c], { config: baseConfig, rootDir: '/tmp' });
    expect(res.outcomes.get('a')?.status).toBe('failed');
    expect(res.outcomes.get('b')?.status).toBe('skipped');
    expect(res.outcomes.get('b')?.reason).toContain('prereq a');
    expect(res.outcomes.get('c')?.status).toBe('skipped');
    expect(res.hasFailures).toBe(true);
    expect(res.hasSkipped).toBe(true);
  });

  test('reports missing requires as a skip, not a crash', async () => {
    const a = mkFix({ id: 'a', requires: ['ghost'], scan: async () => false });
    const res = await runFixDAG([a], { config: baseConfig, rootDir: '/tmp' });
    expect(res.outcomes.get('a')?.status).toBe('skipped');
    expect(res.outcomes.get('a')?.reason).toContain('ghost');
  });

  test('manual when an issue exists and applyFixes=false', async () => {
    const a = mkFix({ id: 'a', scan: async () => true });
    const res = await runFixDAG([a], { config: baseConfig, rootDir: '/tmp', applyFixes: false });
    expect(res.outcomes.get('a')?.status).toBe('manual');
    expect(res.outcomes.get('a')?.issueDetected).toBe(true);
  });

  test('applies fixes when applyFixes=true and reports fixed', async () => {
    let applied = false;
    const a = mkFix({
      id: 'a',
      scan: async () => true,
      fix: async () => { applied = true; return true; },
    });
    const res = await runFixDAG([a], { config: baseConfig, rootDir: '/tmp', applyFixes: true });
    expect(applied).toBe(true);
    expect(res.outcomes.get('a')?.status).toBe('fixed');
  });

  test('streams outcomes via onOutcome as each fix completes', async () => {
    const seen: string[] = [];
    const a = mkFix({ id: 'a', scan: async () => false });
    const b = mkFix({ id: 'b', requires: ['a'], scan: async () => false });
    await runFixDAG([b, a], {
      config: baseConfig,
      rootDir: '/tmp',
      onOutcome: (o) => seen.push(o.id),
    });
    expect(seen).toEqual(['a', 'b']);
  });
});
