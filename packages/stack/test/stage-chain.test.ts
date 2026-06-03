/**
 * Tests for the stage chain runner.
 *
 * Verifies the guarantees of the dev → staging → prod model:
 *   1. Stages run in order. Within a stage, the DAG runner handles ordering.
 *   2. Cross-stage gate: a failed critical fix in stage N marks every fix
 *      in stage N+1..end `skipped` with a shared reason.
 *   3. Tunnel lifecycle: runStageChain owns open/close; failure skip-results
 *      the whole stage without needing per-fix DAG edges.
 */
import {
  runStageChain,
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

describe('runStageChain', () => {
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
    // runStageChain owns the tunnel lifecycle. When openTunnel throws, every
    // fix in the stage is synthesised as skipped and the chain breaks.
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
