/**
 * Tests for the stage chain runner.
 *
 * Verifies the three guarantees of the dev → secrets → staging → prod model:
 *   1. Stages run in order. Within a stage, the DAG runner handles ordering.
 *   2. Cross-stage gate: a failed critical fix in stage N marks every fix
 *      in stage N+1..end `skipped` with a shared reason.
 *   3. Auto-injected tunnel edge: every non-tunnel fix in a stage gains
 *      `requires: ['ssh-tunnel-<stage>']` transparently.
 */
import {
  runStageChain,
  injectStageTunnelEdges,
  TUNNEL_FIX_ID,
} from '../src/utils/stage-chain.js';
import type { Fix, FactiiiConfig, Stage } from '../src/types/index.js';

function mkFix(partial: Partial<Fix> & Pick<Fix, 'id' | 'stage' | 'scan'>): Fix {
  return {
    severity: 'info',
    description: partial.id,
    manualFix: 'manual: ' + partial.id,
    ...partial,
  } as Fix;
}

const baseConfig: FactiiiConfig = { name: 'test' };

describe('injectStageTunnelEdges', () => {
  test('adds ssh-tunnel-staging as a prereq for every non-tunnel staging fix', () => {
    const fixes: Fix[] = [
      mkFix({ id: 'ssh-tunnel-staging', stage: 'staging', scan: async () => false }),
      mkFix({ id: 'docker-installed', stage: 'staging', scan: async () => false }),
      mkFix({ id: 'compose-uploaded', stage: 'staging', scan: async () => false, requires: ['docker-installed'] }),
    ];
    const injected = injectStageTunnelEdges(fixes, 'staging');
    expect(injected.find((f) => f.id === 'ssh-tunnel-staging')!.requires).toBeUndefined();
    expect(injected.find((f) => f.id === 'docker-installed')!.requires).toEqual(['ssh-tunnel-staging']);
    const composeRequires = injected.find((f) => f.id === 'compose-uploaded')!.requires;
    expect(composeRequires).toContain('docker-installed');
    expect(composeRequires).toContain('ssh-tunnel-staging');
  });

  test('skips injection when the tunnel fix is not in the set', () => {
    const fixes: Fix[] = [
      mkFix({ id: 'docker-installed', stage: 'staging', scan: async () => false }),
    ];
    const injected = injectStageTunnelEdges(fixes, 'staging');
    expect(injected[0].requires).toBeUndefined();
  });

  test('is a no-op for dev and secrets stages', () => {
    const fixes: Fix[] = [
      mkFix({ id: 'dev-fix', stage: 'dev', scan: async () => false }),
    ];
    const injected = injectStageTunnelEdges(fixes, 'dev');
    expect(injected).toBe(fixes);
  });

  test('does not duplicate the edge when already present', () => {
    const fixes: Fix[] = [
      mkFix({ id: 'ssh-tunnel-prod', stage: 'prod', scan: async () => false }),
      mkFix({
        id: 'already-declared',
        stage: 'prod',
        scan: async () => false,
        requires: ['ssh-tunnel-prod'],
      }),
    ];
    const injected = injectStageTunnelEdges(fixes, 'prod');
    const out = injected.find((f) => f.id === 'already-declared')!.requires!;
    expect(out.filter((r) => r === 'ssh-tunnel-prod')).toHaveLength(1);
  });
});

describe('runStageChain', () => {
  test('TUNNEL_FIX_ID matches the scanfix registration convention', () => {
    expect(TUNNEL_FIX_ID.staging).toBe('ssh-tunnel-staging');
    expect(TUNNEL_FIX_ID.prod).toBe('ssh-tunnel-prod');
    expect(TUNNEL_FIX_ID.dev).toBeUndefined();
    expect(TUNNEL_FIX_ID.secrets).toBeUndefined();
  });

  test('runs stages in order and reports ok when everything scans clean', async () => {
    const order: Stage[] = [];
    const fixes: Fix[] = [
      mkFix({ id: 'd1', stage: 'dev', scan: async () => { order.push('dev'); return false; } }),
      mkFix({ id: 's1', stage: 'secrets', scan: async () => { order.push('secrets'); return false; } }),
      mkFix({ id: 'st1', stage: 'staging', scan: async () => { order.push('staging'); return false; } }),
    ];
    const res = await runStageChain(fixes, { config: baseConfig, rootDir: '/tmp' });
    expect(order).toEqual(['dev', 'secrets', 'staging']);
    expect(res.chainBroken).toBe(false);
    expect(res.firstFailedStage).toBeNull();
  });

  test('a failed dev fix marks every later-stage fix skipped with a shared reason', async () => {
    const fixes: Fix[] = [
      mkFix({ id: 'd-bad', stage: 'dev', severity: 'critical', scan: async () => { throw new Error('boom'); } }),
      mkFix({ id: 's1', stage: 'secrets', scan: async () => false }),
      mkFix({ id: 'st1', stage: 'staging', scan: async () => false }),
      mkFix({ id: 'p1', stage: 'prod', scan: async () => false }),
    ];
    const res = await runStageChain(fixes, { config: baseConfig, rootDir: '/tmp' });
    expect(res.chainBroken).toBe(true);
    expect(res.firstFailedStage).toBe('dev');
    expect(res.byStage.get('dev')!.outcomes.get('d-bad')!.status).toBe('failed');
    expect(res.byStage.get('secrets')!.outcomes.get('s1')!.status).toBe('skipped');
    expect(res.byStage.get('staging')!.outcomes.get('st1')!.status).toBe('skipped');
    expect(res.byStage.get('staging')!.outcomes.get('st1')!.reason).toContain('dev');
    expect(res.byStage.get('prod')!.outcomes.get('p1')!.status).toBe('skipped');
  });

  test('a critical-severity issue without auto-fix breaks the chain', async () => {
    const fixes: Fix[] = [
      // scan returns true (issue) + fix=null + severity=critical + applyFixes=false → manual.
      mkFix({ id: 'd-manual', stage: 'dev', severity: 'critical', scan: async () => true, fix: null }),
      mkFix({ id: 'st1', stage: 'staging', scan: async () => false }),
    ];
    const res = await runStageChain(fixes, { config: baseConfig, rootDir: '/tmp' });
    expect(res.chainBroken).toBe(true);
    expect(res.firstFailedStage).toBe('dev');
    expect(res.byStage.get('staging')!.outcomes.get('st1')!.status).toBe('skipped');
  });

  test('a warning-severity manual issue does NOT break the chain', async () => {
    const fixes: Fix[] = [
      mkFix({ id: 'd-warn', stage: 'dev', severity: 'warning', scan: async () => true, fix: null }),
      mkFix({ id: 'st1', stage: 'staging', scan: async () => false }),
    ];
    const res = await runStageChain(fixes, { config: baseConfig, rootDir: '/tmp' });
    expect(res.chainBroken).toBe(false);
    expect(res.byStage.get('staging')!.outcomes.get('st1')!.status).toBe('ok');
  });

  test('auto-injects the tunnel edge so staging fixes skip when the tunnel scan fails', async () => {
    const fixes: Fix[] = [
      mkFix({
        id: 'ssh-tunnel-staging',
        stage: 'staging',
        severity: 'critical',
        scan: async () => { throw new Error('cant open tunnel'); },
      }),
      mkFix({ id: 'docker-on-staging', stage: 'staging', scan: async () => false }),
      mkFix({ id: 'compose-on-staging', stage: 'staging', scan: async () => false }),
    ];
    const res = await runStageChain(fixes, { config: baseConfig, rootDir: '/tmp' });
    const stagingOutcomes = res.byStage.get('staging')!.outcomes;
    expect(stagingOutcomes.get('ssh-tunnel-staging')!.status).toBe('failed');
    expect(stagingOutcomes.get('docker-on-staging')!.status).toBe('skipped');
    expect(stagingOutcomes.get('docker-on-staging')!.reason).toContain('ssh-tunnel-staging');
    expect(stagingOutcomes.get('compose-on-staging')!.status).toBe('skipped');
  });

  test('narrowed stages option skips unlisted stages entirely', async () => {
    const calls: Stage[] = [];
    const fixes: Fix[] = [
      mkFix({ id: 'd1', stage: 'dev', scan: async () => { calls.push('dev'); return false; } }),
      mkFix({ id: 'p1', stage: 'prod', scan: async () => { calls.push('prod'); return false; } }),
    ];
    const res = await runStageChain(fixes, {
      config: baseConfig,
      rootDir: '/tmp',
      stages: ['dev'],
    });
    expect(calls).toEqual(['dev']);
    expect(res.byStage.has('prod')).toBe(false);
  });
});
