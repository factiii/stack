/**
 * Tests for the stage chain runner.
 *
 * Verifies the three guarantees of the dev → staging → prod model:
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

const baseConfig: FactiiiConfig = {
  name: 'test',
  staging: { domain: 'staging.example.com' } as import('../src/types/index.js').EnvironmentConfig,
};

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

  test('is a no-op for dev stage', () => {
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
  });

  test('runs stages in order and reports ok when everything scans clean', async () => {
    const order: Stage[] = [];
    const fixes: Fix[] = [
      mkFix({ id: 'd1', stage: 'dev', scan: async () => { order.push('dev'); return false; } }),
      mkFix({ id: 'st1', stage: 'staging', scan: async () => { order.push('staging'); return false; } }),
    ];
    const res = await runStageChain(fixes, {
      config: baseConfig,
      rootDir: '/tmp',
      tunnel: {
        openTunnel: ((_stage, _env, _key) => ({ socket: '/tmp/s', host: 'h', user: 'u', keyPath: null, stage: _stage })) as typeof import('../src/utils/ssh-tunnel.js').openTunnel,
        closeTunnel: (() => {}) as typeof import('../src/utils/ssh-tunnel.js').closeTunnel,
      },
    });
    expect(order).toEqual(['dev', 'staging']);
    expect(res.chainBroken).toBe(false);
    expect(res.firstFailedStage).toBeNull();
  });

  test('a failed dev fix marks every later-stage fix skipped with a shared reason', async () => {
    const fixes: Fix[] = [
      mkFix({ id: 'd-bad', stage: 'dev', severity: 'critical', scan: async () => { throw new Error('boom'); } }),
      mkFix({ id: 'st1', stage: 'staging', scan: async () => false }),
      mkFix({ id: 'p1', stage: 'prod', scan: async () => false }),
    ];
    const res = await runStageChain(fixes, { config: baseConfig, rootDir: '/tmp' });
    expect(res.chainBroken).toBe(true);
    expect(res.firstFailedStage).toBe('dev');
    expect(res.byStage.get('dev')!.outcomes.get('d-bad')!.status).toBe('failed');
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
    const res = await runStageChain(fixes, {
      config: baseConfig,
      rootDir: '/tmp',
      tunnel: {
        openTunnel: ((_stage, _env, _key) => ({ socket: '/tmp/s', host: 'h', user: 'u', keyPath: null, stage: _stage })) as typeof import('../src/utils/ssh-tunnel.js').openTunnel,
        closeTunnel: (() => {}) as typeof import('../src/utils/ssh-tunnel.js').closeTunnel,
      },
    });
    expect(res.chainBroken).toBe(false);
    expect(res.byStage.get('staging')!.outcomes.get('st1')!.status).toBe('ok');
  });

  test('runner-opened tunnel failure skip-results the whole stage (no per-fix DAG edges needed)', async () => {
    // With the new architecture, runStageChain owns the tunnel lifecycle.
    // When openTunnel throws, every fix in the stage is synthesised as
    // skipped — no injectStageTunnelEdges call is required.
    const fixes: Fix[] = [
      mkFix({ id: 'docker-on-staging', stage: 'staging', scan: async () => false }),
      mkFix({ id: 'compose-on-staging', stage: 'staging', scan: async () => false }),
    ];
    const res = await runStageChain(fixes, {
      config: baseConfig,
      rootDir: '/tmp',
      tunnel: {
        openTunnel: (() => { throw new Error('cant open tunnel'); }) as typeof import('../src/utils/ssh-tunnel.js').openTunnel,
        closeTunnel: (() => {}) as typeof import('../src/utils/ssh-tunnel.js').closeTunnel,
      },
    });
    const stagingOutcomes = res.byStage.get('staging')!.outcomes;
    expect(stagingOutcomes.get('docker-on-staging')!.status).toBe('skipped');
    expect(stagingOutcomes.get('docker-on-staging')!.reason).toMatch(/tunnel open failed/);
    expect(stagingOutcomes.get('compose-on-staging')!.status).toBe('skipped');
    expect(res.chainBroken).toBe(true);
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

describe('runStageChain — tunnel lifecycle', () => {
  test('opens tunnel on entry to staging and closes on exit', async () => {
    const events: string[] = [];
    const fakeHandle = { socket: '/tmp/s', host: 'h', user: 'u', keyPath: null, stage: 'staging' };

    const fixes: Fix[] = [
      mkFix({
        id: 'staging-only-fix',
        stage: 'staging',
        scan: async () => {
          events.push('scan');
          return false;
        },
      }),
    ];

    await runStageChain(fixes, {
      config: baseConfig,
      rootDir: '/tmp',
      stages: ['staging'],
      tunnel: {
        openTunnel: ((stage: Stage) => {
          events.push('open:' + stage);
          return fakeHandle as unknown as ReturnType<typeof import('../src/utils/ssh-tunnel.js').openTunnel>;
        }) as typeof import('../src/utils/ssh-tunnel.js').openTunnel,
        closeTunnel: ((handle) => {
          events.push('close:' + handle.stage);
        }) as typeof import('../src/utils/ssh-tunnel.js').closeTunnel,
      },
    });

    expect(events).toEqual(['open:staging', 'scan', 'close:staging']);
  });

  test('skip-results the whole stage when openTunnel throws', async () => {
    const fakeFix = mkFix({
      id: 'doomed',
      stage: 'staging',
      scan: async () => false,
    });

    const result = await runStageChain([fakeFix], {
      config: baseConfig,
      rootDir: '/tmp',
      stages: ['staging'],
      tunnel: {
        openTunnel: (() => { throw new Error('refused: bad key'); }) as typeof import('../src/utils/ssh-tunnel.js').openTunnel,
        closeTunnel: (() => {}) as typeof import('../src/utils/ssh-tunnel.js').closeTunnel,
      },
    });

    const stagingResult = result.byStage.get('staging')!;
    const outcome = stagingResult.outcomes.get('doomed')!;
    expect(outcome.status).toBe('skipped');
    expect(outcome.reason).toMatch(/tunnel open failed/);
    expect(result.firstFailedStage).toBe('staging');
  });

  test('does not open tunnel when staging has zero fixes', async () => {
    const events: string[] = [];

    await runStageChain([
      mkFix({ id: 'dev-only', stage: 'dev', scan: async () => false }),
    ], {
      config: baseConfig,
      rootDir: '/tmp',
      stages: ['dev', 'staging'],
      tunnel: {
        openTunnel: ((stage: Stage) => {
          events.push('open:' + stage);
          return { stage } as unknown as ReturnType<typeof import('../src/utils/ssh-tunnel.js').openTunnel>;
        }) as typeof import('../src/utils/ssh-tunnel.js').openTunnel,
        closeTunnel: (() => {}) as typeof import('../src/utils/ssh-tunnel.js').closeTunnel,
      },
    });

    expect(events).toEqual([]);
  });

  test('production callers omit `tunnel` and get the real implementation', async () => {
    // We can't actually open a real SSH tunnel in unit tests, so this test
    // just confirms the option is optional. Pass only dev fixes so the real
    // openTunnel is never invoked.
    const result = await runStageChain([
      mkFix({ id: 'dev-only', stage: 'dev', scan: async () => false }),
    ], {
      config: baseConfig,
      rootDir: '/tmp',
      stages: ['dev'],
    });
    expect(result.byStage.get('dev')?.outcomes.get('dev-only')?.status).toBe('ok');
  });
});
