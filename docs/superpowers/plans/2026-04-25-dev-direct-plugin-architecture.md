# Dev-Direct Plugin Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the dev-direct plugin execution model defined by `docs/superpowers/specs/2026-04-25-dev-direct-plugin-architecture-design.md` (commit `0b10be1`).

**Architecture:** Single execution context (the dev machine). One routing primitive: `serverExec(stage, cmd)`. Three stages (`dev`/`staging`/`prod`) — `secrets` is folded into `dev`. The SSH tunnel is a runtime resource owned by `runStageChain`, opened on entry to a remote stage and closed on exit. `scan.ts`/`fix.ts`/`deploy.ts` delegate stage execution to `runStageChain`; the existing multi-pass loop and per-stage SSH delegation are deleted. STANDARDS.md is rewritten to match.

**Tech Stack:** TypeScript 5, pnpm workspaces, Jest, Node.js (≥20), `child_process.spawnSync`/`execSync`, OpenSSH ControlMaster.

**Out of scope (deferred to follow-on specs):** migrating individual scanfixes off `process.env.GITHUB_ACTIONS` guards; retiring `ssh-helper.ts`; new scanfixes (multi-repo discovery, sync-verification, `stack.yml` delivery); renderer / output UX of the summary; removing Node/git from prod.

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `packages/stack/src/utils/server-exec.ts` | **Create** | The single routing primitive. `serverExec(stage, cmd)` — `dev` → `execSync` local; `staging`/`prod` → `tunnelExec` via `getTunnel(stage)`. |
| `packages/stack/test/server-exec.test.ts` | **Create** | Unit tests for `serverExec`. |
| `packages/stack/src/types/plugin.ts` | **Modify** | Narrow `ReachVia` to just `'local'`. Narrow `Stage` to `'dev' \| 'staging' \| 'prod'`. |
| `packages/stack/src/utils/stage-chain.ts` | **Modify** | Narrow `STAGE_ORDER` to `['dev','staging','prod']`. Move tunnel lifecycle into `runStageChain`. Add optional injectable tunnel fns parameter. Delete `injectStageTunnelEdges` and `TUNNEL_FIX_ID`. |
| `packages/stack/test/stage-chain.test.ts` | **Modify** | Drop `injectStageTunnelEdges`/`TUNNEL_FIX_ID` tests; add tunnel-lifecycle tests. |
| `packages/stack/test/stage-order.test.ts` | **Create** | Lock-in: assert `STAGE_ORDER === ['dev','staging','prod']`. |
| `packages/stack/test/reach-via.test.ts` | **Create** | Lock-in: typecheck-only assertion that `ReachVia` is just `'local'`. |
| `packages/stack/src/plugins/pipelines/factiii/scanfix/ssh-tunnel.ts` | **Delete** | Tunnel is now a runtime resource, not a Fix. |
| `packages/stack/src/plugins/pipelines/factiii/index.ts` | **Modify** | Remove `sshTunnelFixes` import/use. `canReach` already returns local-or-unreachable; just type-narrow. |
| `packages/stack/src/plugins/pipelines/aws/index.ts` | **Modify** | `canReach` returns `via: 'api'` in one branch — replace with `'local'` (functionally identical: AWS API calls run from dev). |
| `packages/stack/src/cli/scan.ts` | **Modify** | Replace per-stage local/remote split + per-fix scan loop with a single `runStageChain` call. Render `StageChainResult`. Delete `'secrets'` from stage lists. |
| `packages/stack/src/cli/fix.ts` | **Modify** | Replace `runLocalFixes` multi-pass loop and remote-delegation with a single `runStageChain` call (`applyFixes: true`). Render `StageChainResult`. Delete `'secrets'` from stage lists. |
| `packages/stack/src/cli/deploy.ts` | **Modify** | Run `runStageChain` for prereqs, then call `pipeline.deployStage`. Delete `'secrets'` from stage lists. |
| `packages/stack/test/can-reach.test.ts` | **Modify** | Add assertion that no `canReach` path returns `via: 'ssh'` or `via: 'workflow'`. |
| Existing scanfix files with `stage: 'secrets'` (16 fixes across 7 files) | **Modify** | Re-tag to `stage: 'dev'`. Files: `factiii/scanfix/vault.ts` (3), `factiii/scanfix/secrets.ts` (9), `factiii/scanfix/ssh-verify.ts` (1 — and may itself be removable depending on Task 6), `pipelines/aws/scanfix/iam.ts` (2), `pipelines/aws/scanfix/credentials.ts` (2), `addons/auth/scanfix/secrets.ts` (3), `addons/vercel/scanfix/token.ts` (1). |
| `packages/stack/STANDARDS.md` | **Modify** | Full rewrite of the routing/stage sections. |

---

## Task 1: Add `serverExec` utility (TDD)

**Files:**
- Create: `packages/stack/src/utils/server-exec.ts`
- Create: `packages/stack/test/server-exec.test.ts`

- [ ] **Step 1: Write the failing test file**

Write to `packages/stack/test/server-exec.test.ts`:

```typescript
/**
 * Tests for serverExec — the single routing primitive for shell commands
 * issued by scanfixes.
 */
import * as cp from 'child_process';
import * as tunnel from '../src/utils/ssh-tunnel.js';
import { serverExec } from '../src/utils/server-exec.js';

jest.mock('child_process');
jest.mock('../src/utils/ssh-tunnel.js');

describe('serverExec', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('stage="dev" calls execSync and returns trimmed stdout', () => {
    (cp.execSync as jest.Mock).mockReturnValue(Buffer.from('  hello world\n'));
    const out = serverExec('dev', 'echo hello');
    expect(out).toBe('hello world');
    expect(cp.execSync).toHaveBeenCalledWith('echo hello', expect.objectContaining({ encoding: 'utf8' }));
  });

  test('stage="staging" calls tunnelExec via the cached handle', () => {
    const fakeHandle = { socket: '/tmp/sock', host: 'h', user: 'u', keyPath: null, stage: 'staging' };
    (tunnel.getTunnel as jest.Mock).mockReturnValue(fakeHandle);
    (tunnel.tunnelExec as jest.Mock).mockReturnValue('docker output');
    const out = serverExec('staging', 'docker ps');
    expect(out).toBe('docker output');
    expect(tunnel.getTunnel).toHaveBeenCalledWith('staging');
    expect(tunnel.tunnelExec).toHaveBeenCalledWith(fakeHandle, 'docker ps');
  });

  test('stage="prod" calls tunnelExec via the cached handle', () => {
    const fakeHandle = { socket: '/tmp/sock', host: 'h', user: 'u', keyPath: null, stage: 'prod' };
    (tunnel.getTunnel as jest.Mock).mockReturnValue(fakeHandle);
    (tunnel.tunnelExec as jest.Mock).mockReturnValue('out');
    serverExec('prod', 'cat /etc/os-release');
    expect(tunnel.getTunnel).toHaveBeenCalledWith('prod');
  });

  test('staging with no cached tunnel throws clearly', () => {
    (tunnel.getTunnel as jest.Mock).mockReturnValue(null);
    expect(() => serverExec('staging', 'docker ps')).toThrow(
      /serverExec: no tunnel open for staging/,
    );
  });

  test('execSync non-zero exit propagates as throw', () => {
    (cp.execSync as jest.Mock).mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('Command failed: exit 1');
      throw err;
    });
    expect(() => serverExec('dev', 'false')).toThrow(/Command failed/);
  });

  test('tunnelExec error propagates as throw', () => {
    const fakeHandle = { socket: '/tmp/sock', host: 'h', user: 'u', keyPath: null, stage: 'staging' };
    (tunnel.getTunnel as jest.Mock).mockReturnValue(fakeHandle);
    (tunnel.tunnelExec as jest.Mock).mockImplementation(() => {
      throw new Error('tunnel exec failed (exit 2): nope');
    });
    expect(() => serverExec('staging', 'thing')).toThrow(/tunnel exec failed/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @factiii/stack test test/server-exec.test.ts`
Expected: All tests FAIL with `Cannot find module '../src/utils/server-exec.js'`.

- [ ] **Step 3: Write the minimal implementation**

Write to `packages/stack/src/utils/server-exec.ts`:

```typescript
/**
 * serverExec — single routing primitive for shell commands issued by scanfixes.
 *
 * Usage from a scanfix:
 *   import { serverExec } from '../../utils/server-exec.js';
 *   const out = serverExec(stage, 'docker ps -q -f name=' + name);
 *
 * Routing:
 *   - stage === 'dev'              → local execSync
 *   - stage === 'staging' | 'prod' → tunnelExec via the per-stage tunnel
 *                                    handle cached in ssh-tunnel.ts. Throws
 *                                    if no tunnel is cached (in practice
 *                                    impossible because runStageChain opens
 *                                    the tunnel on stage entry).
 *
 * Returns trimmed stdout. Throws on non-zero exit (both paths).
 */

import { execSync } from 'child_process';
import { getTunnel, tunnelExec } from './ssh-tunnel.js';
import type { Stage } from '../types/index.js';

export function serverExec(stage: Stage, cmd: string): string {
  if (stage === 'dev') {
    const buf = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return buf.toString().trim();
  }

  // staging or prod — must have an open tunnel
  const handle = getTunnel(stage);
  if (!handle) {
    throw new Error(
      'serverExec: no tunnel open for ' + stage +
      '. runStageChain is responsible for opening tunnels on stage entry. ' +
      'If you reached this from a unit test, mock openTunnel/getTunnel.',
    );
  }
  return tunnelExec(handle, cmd);
}
```

Note the import uses `'./ssh-tunnel.js'` (relative) and `'../types/index.js'` (the existing types barrel).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @factiii/stack test test/server-exec.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/stack/src/utils/server-exec.ts packages/stack/test/server-exec.test.ts
git commit -m "feat(stack): add serverExec utility for stage-routed command execution"
```

---

## Task 2: Re-tag `stage: 'secrets'` scanfixes to `stage: 'dev'`

This is mechanical: 16 fix definitions across 7 files must change `stage: 'secrets'` → `stage: 'dev'`. The Stage type still has `'secrets'` in the union after this task; Task 4 narrows it, and TypeScript will then catch any miss.

**Files:**
- Modify: `packages/stack/src/plugins/pipelines/factiii/scanfix/vault.ts` (lines 23, 41, 74)
- Modify: `packages/stack/src/plugins/pipelines/factiii/scanfix/secrets.ts` (lines 551, 602, 647, 1038, 1111, 1184, 1244, 1316; also any other `stage: 'secrets'` matches)
- Modify: `packages/stack/src/plugins/pipelines/factiii/scanfix/ssh-verify.ts` (line 57)
- Modify: `packages/stack/src/plugins/pipelines/aws/scanfix/iam.ts` (lines 304, 425)
- Modify: `packages/stack/src/plugins/pipelines/aws/scanfix/credentials.ts` (lines 650, 741)
- Modify: `packages/stack/src/plugins/addons/auth/scanfix/secrets.ts` (lines 91, 129, 176)
- Modify: `packages/stack/src/plugins/addons/vercel/scanfix/token.ts` (line 14)

- [ ] **Step 1: Mechanical replace across all listed files**

Use a single sed pass to flip every `stage: 'secrets'` to `stage: 'dev'` in the listed files only (avoid touching unrelated code or string literals that mention "secrets" in comments).

```bash
sed -i '' "s/stage: 'secrets'/stage: 'dev'/g" \
  packages/stack/src/plugins/pipelines/factiii/scanfix/vault.ts \
  packages/stack/src/plugins/pipelines/factiii/scanfix/secrets.ts \
  packages/stack/src/plugins/pipelines/factiii/scanfix/ssh-verify.ts \
  packages/stack/src/plugins/pipelines/aws/scanfix/iam.ts \
  packages/stack/src/plugins/pipelines/aws/scanfix/credentials.ts \
  packages/stack/src/plugins/addons/auth/scanfix/secrets.ts \
  packages/stack/src/plugins/addons/vercel/scanfix/token.ts
```

- [ ] **Step 2: Verify zero remaining `stage: 'secrets'` in src**

Run: `grep -rn "stage: 'secrets'" packages/stack/src/ --include='*.ts'`
Expected: No output (exit code 1).

- [ ] **Step 3: Type-check the workspace**

Run: `pnpm --filter @factiii/stack check-types`
Expected: PASS. (The `Stage` union still allows `'secrets'`, so this is just confirming nothing else broke.)

- [ ] **Step 4: Run the full test suite**

Run: `pnpm --filter @factiii/stack test`
Expected: All existing tests PASS. Any test that asserts `stage: 'secrets'` for a fix listed in the spec's affected files would need updating — note any failures and fix the assertion before proceeding.

- [ ] **Step 5: Commit**

```bash
git add packages/stack/src/plugins/pipelines/factiii/scanfix/vault.ts \
        packages/stack/src/plugins/pipelines/factiii/scanfix/secrets.ts \
        packages/stack/src/plugins/pipelines/factiii/scanfix/ssh-verify.ts \
        packages/stack/src/plugins/pipelines/aws/scanfix/iam.ts \
        packages/stack/src/plugins/pipelines/aws/scanfix/credentials.ts \
        packages/stack/src/plugins/addons/auth/scanfix/secrets.ts \
        packages/stack/src/plugins/addons/vercel/scanfix/token.ts
git commit -m "refactor(stack): re-tag stage:'secrets' fixes to stage:'dev'

Folds the legacy secrets stage into dev. Each re-tagged fix retains its
behavior; cross-fix ordering still falls out of the input order in
runFixDAG's stable topo sort. Explicit \`requires\` chains are added by
the migration spec, not here."
```

---

## Task 3: Update CLI files to drop `'secrets'` from stage lists

**Files:**
- Modify: `packages/stack/src/cli/scan.ts:303,511,521,527,528,533,537,568,612,617`
- Modify: `packages/stack/src/cli/fix.ts:255,259,263,266,276,303,364`
- Modify: `packages/stack/src/cli/deploy.ts` (any `'secrets'` references in stage lists)

This is also mechanical but more careful — we're dropping `'secrets'` from `Stage[]` arrays and from `if (stage === 'dev' || stage === 'secrets')` style branches. The corresponding `secrets` flag on options (`options.secrets`) also goes away.

- [ ] **Step 1: Edit `scan.ts` — narrow stage arrays**

In `packages/stack/src/cli/scan.ts`, replace:
- Line 303: `const stages: Stage[] = ['dev', 'secrets', 'staging', 'prod'];` → `const stages: Stage[] = ['dev', 'staging', 'prod'];`
- Line 511: `let stages: Stage[] = ['dev', 'secrets', 'staging', 'prod'];` → `let stages: Stage[] = ['dev', 'staging', 'prod'];`
- Line 521: `else if (options.secrets) stages = ['secrets'];` → **delete this line entirely**
- Line 523: `stages = ['dev', 'secrets', 'staging'];` → `stages = ['dev', 'staging'];`
- Line 528: `stages = ['dev', 'secrets', 'prod'];` → `stages = ['dev', 'prod'];`
- Line 537: `if (stages.some(s => s !== 'dev' && s !== 'secrets')) {` → `if (stages.some(s => s !== 'dev')) {`
- Line 568: `if (stage === 'dev' || stage === 'secrets') {` → `if (stage === 'dev') {`
- Line 612: `secrets: [],` (in the `problems` initializer) → **delete this line**
- Lines 483, 612, 615: drop `secrets` from the `ScanProblems` returned shape — see Step 2.

The empty-config early-return at ~line 483 returns `{ dev: [], secrets: [], staging: [], prod: [] }`. Update it to match the new `ScanProblems` shape (Step 2 narrows the type).

- [ ] **Step 2: Narrow the `ScanProblems` type**

In `packages/stack/src/types/cli.ts` (or wherever `ScanProblems` is defined — find with `grep -rn "interface ScanProblems\|type ScanProblems" packages/stack/src/types/`):

```typescript
// Before
export interface ScanProblems {
  dev: Fix[];
  secrets: Fix[];
  staging: Fix[];
  prod: Fix[];
}

// After
export interface ScanProblems {
  dev: Fix[];
  staging: Fix[];
  prod: Fix[];
}
```

Also drop `secrets?: boolean` from `ScanOptions` and `FixOptions` if present (`grep -n "secrets" packages/stack/src/types/cli.ts`).

- [ ] **Step 3: Edit `fix.ts`**

In `packages/stack/src/cli/fix.ts`:
- Line 255: `let stages: Stage[] = ['dev', 'secrets', 'staging', 'prod'];` → `let stages: Stage[] = ['dev', 'staging', 'prod'];`
- Line 259: `else if (options.secrets) stages = ['secrets'];` → **delete this line**
- Line 261: `stages = ['dev', 'secrets', 'staging'];` → `stages = ['dev', 'staging'];`
- Line 265: `stages = ['dev', 'secrets', 'prod'];` → `stages = ['dev', 'prod'];`
- Line 276: `if (stages.some(s => s !== 'dev' && s !== 'secrets')) {` → `if (stages.some(s => s !== 'dev')) {`
- Line 303: `if (stage === 'dev' || stage === 'secrets') {` → `if (stage === 'dev') {`
- Line 364: `const allStages: Stage[] = ['dev', 'secrets', 'staging', 'prod'];` → `const allStages: Stage[] = ['dev', 'staging', 'prod'];`

- [ ] **Step 4: Edit `deploy.ts`**

In `packages/stack/src/cli/deploy.ts`, find any `'secrets'` references in `Stage[]` literals or `===` checks:

```bash
grep -n "'secrets'" packages/stack/src/cli/deploy.ts
```

For each match, drop the `'secrets'` element from arrays or the secrets branch from conditionals, mirroring the patterns above.

If `deploy-secrets.ts` exists and is invoked from `deploy.ts`, leave its internal `--secrets` CLI flag handling alone for now — that's a `secrets` *subcommand* of deploy (vault management UI), not a stage. Only edit places that put `'secrets'` into a `Stage[]` or compare `stage === 'secrets'`.

- [ ] **Step 5: Drop the `--secrets` flag from the CLI parser**

If the CLI command parser (likely `packages/stack/bin/stack` or `packages/stack/src/cli/index.ts`) registers a `--secrets` option for `scan` or `fix` (separate from the `deploy --secrets` subcommand), remove it.

```bash
grep -n "secrets" packages/stack/bin/stack packages/stack/src/cli/index.ts 2>/dev/null
```

For matches in scan/fix option declarations, delete those declarations. Leave any `deploy --secrets` subcommand wiring intact.

- [ ] **Step 6: Type-check**

Run: `pnpm --filter @factiii/stack check-types`
Expected: PASS. The `Stage` union still has `'secrets'`, so existing `Stage[]` typing accepts both shapes; we'll narrow in Task 4.

- [ ] **Step 7: Run the full test suite**

Run: `pnpm --filter @factiii/stack test`
Expected: PASS. Any test that asserted on the `secrets` field of `ScanProblems` or `--secrets` CLI behavior must be updated or deleted (search with `grep -rn "secrets" packages/stack/test/`). Update before continuing.

- [ ] **Step 8: Commit**

```bash
git add packages/stack/src/cli/scan.ts \
        packages/stack/src/cli/fix.ts \
        packages/stack/src/cli/deploy.ts \
        packages/stack/src/types/cli.ts \
        packages/stack/bin/stack \
        packages/stack/src/cli/index.ts \
        packages/stack/test/
git commit -m "refactor(stack): drop 'secrets' from CLI stage lists and ScanProblems"
```

(Stage CLI parser file paths in `git add` are best-effort — adjust to whatever you actually edited.)

---

## Task 4: Narrow `Stage` type to `'dev' | 'staging' | 'prod'`

**Files:**
- Modify: `packages/stack/src/types/plugin.ts:13`

- [ ] **Step 1: Narrow the `Stage` union**

In `packages/stack/src/types/plugin.ts`:

```typescript
// Before
export type Stage = 'dev' | 'secrets' | 'staging' | 'prod';

// After
export type Stage = 'dev' | 'staging' | 'prod';
```

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @factiii/stack check-types`
Expected: PASS. Tasks 2 and 3 removed every site that still produced `'secrets'`. If new errors appear, they're misses from those tasks — fix them by removing the `'secrets'` literal at each error site (do NOT widen the `Stage` union back).

- [ ] **Step 3: Run the full test suite**

Run: `pnpm --filter @factiii/stack test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/stack/src/types/plugin.ts
git commit -m "refactor(stack): narrow Stage union to dev|staging|prod"
```

---

## Task 5: Add `STAGE_ORDER` lock-in test, then narrow `STAGE_ORDER`

**Files:**
- Create: `packages/stack/test/stage-order.test.ts`
- Modify: `packages/stack/src/utils/stage-chain.ts:31`

- [ ] **Step 1: Write the failing lock-in test**

Write to `packages/stack/test/stage-order.test.ts`:

```typescript
/**
 * Lock-in test for STAGE_ORDER.
 *
 * If anyone adds, removes, or reorders a stage, this test fails. The intent
 * is to force a deliberate revisit of the dev-direct architecture spec
 * (docs/superpowers/specs/2026-04-25-dev-direct-plugin-architecture-design.md)
 * before the change lands.
 */
import { STAGE_ORDER } from '../src/utils/stage-chain.js';

describe('STAGE_ORDER lock-in', () => {
  test('is exactly [dev, staging, prod]', () => {
    expect(STAGE_ORDER).toEqual(['dev', 'staging', 'prod']);
  });

  test('does not include the legacy secrets stage', () => {
    expect(STAGE_ORDER).not.toContain('secrets');
  });
});
```

- [ ] **Step 2: Run the lock-in test (it should fail because STAGE_ORDER still has 'secrets')**

Run: `pnpm --filter @factiii/stack test test/stage-order.test.ts`
Expected: FAIL — current `STAGE_ORDER` is `['dev', 'secrets', 'staging', 'prod']`.

- [ ] **Step 3: Narrow `STAGE_ORDER`**

In `packages/stack/src/utils/stage-chain.ts`:

```typescript
// Before
export const STAGE_ORDER: Stage[] = ['dev', 'secrets', 'staging', 'prod'];

// After
export const STAGE_ORDER: Stage[] = ['dev', 'staging', 'prod'];
```

- [ ] **Step 4: Run the lock-in test (it should now pass)**

Run: `pnpm --filter @factiii/stack test test/stage-order.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `pnpm --filter @factiii/stack test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/stack/test/stage-order.test.ts packages/stack/src/utils/stage-chain.ts
git commit -m "refactor(stack): narrow STAGE_ORDER to [dev,staging,prod] + add lock-in test"
```

---

## Task 6: Move tunnel lifecycle into `runStageChain` (TDD)

This is the largest task. It (a) adds tunnel-open/close around remote stages, (b) adds the optional injectable tunnel-fns parameter, and (c) prepares the ground for deleting the `ssh-tunnel-<stage>` scanfix and `injectStageTunnelEdges` in Task 7.

**Files:**
- Modify: `packages/stack/src/utils/stage-chain.ts`
- Modify: `packages/stack/test/stage-chain.test.ts`

- [ ] **Step 1: Add the new tunnel-lifecycle test cases**

In `packages/stack/test/stage-chain.test.ts`, append after the existing `describe('runStageChain', ...)` block (or as a sibling describe):

```typescript
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
```

The existing `injectStageTunnelEdges` describe blocks at the top of the file will be deleted in Task 7 — leave them alone for now; we want this commit to add the new behavior without breaking anything.

- [ ] **Step 2: Run the tests (they should fail — `runStageChain` doesn't accept `tunnel` yet)**

Run: `pnpm --filter @factiii/stack test test/stage-chain.test.ts`
Expected: New tests FAIL — TypeScript error on `tunnel:` property in options.

- [ ] **Step 3: Extend `StageChainOptions` and add the lifecycle**

In `packages/stack/src/utils/stage-chain.ts`, replace the existing imports and `StageChainOptions` interface:

```typescript
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
```

Now replace the body of `runStageChain` with the new lifecycle:

```typescript
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
```

Note: this commit keeps `injectStageTunnelEdges` and `TUNNEL_FIX_ID` exports defined in the file (Task 7 deletes them). Just remove the `injectStageTunnelEdges` *call* inside `runStageChain` — fixes are passed to `runFixDAG` directly without the tunnel-edge injection.

- [ ] **Step 4: Run the tunnel-lifecycle tests**

Run: `pnpm --filter @factiii/stack test test/stage-chain.test.ts`
Expected: New tests PASS. Older `injectStageTunnelEdges` tests still pass (function still exported; just unused by `runStageChain`).

- [ ] **Step 5: Run the full test suite**

Run: `pnpm --filter @factiii/stack test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/stack/src/utils/stage-chain.ts packages/stack/test/stage-chain.test.ts
git commit -m "feat(stack): runStageChain owns tunnel lifecycle per remote stage

Adds opening/closing of the per-stage SSH tunnel inside runStageChain,
gated behind an optional injectable tunnel-fns parameter for tests.
openTunnel failure now skip-results the whole stage and breaks the
chain. injectStageTunnelEdges call is removed from the runner; the
helper itself is kept temporarily and deleted in the next commit."
```

---

## Task 7: Delete `ssh-tunnel-<stage>` scanfix file and `injectStageTunnelEdges`

**Files:**
- Delete: `packages/stack/src/plugins/pipelines/factiii/scanfix/ssh-tunnel.ts`
- Modify: `packages/stack/src/plugins/pipelines/factiii/index.ts` (remove import + spread)
- Modify: `packages/stack/src/utils/stage-chain.ts` (delete `injectStageTunnelEdges` and `TUNNEL_FIX_ID`)
- Modify: `packages/stack/test/stage-chain.test.ts` (delete `describe('injectStageTunnelEdges', ...)` blocks)

- [ ] **Step 1: Remove the scanfix file**

```bash
git rm packages/stack/src/plugins/pipelines/factiii/scanfix/ssh-tunnel.ts
```

- [ ] **Step 2: Remove its import + spread from the factiii index**

In `packages/stack/src/plugins/pipelines/factiii/index.ts`:
- Delete the line `import { sshTunnelFixes } from './scanfix/ssh-tunnel.js';` (around line 77).
- Delete the line `...sshTunnelFixes,` from the `static readonly fixes: Fix[] = [...]` array (around line 273).

- [ ] **Step 3: Delete `injectStageTunnelEdges` and `TUNNEL_FIX_ID` from `stage-chain.ts`**

In `packages/stack/src/utils/stage-chain.ts`, delete the `TUNNEL_FIX_ID` export and the entire `injectStageTunnelEdges` function. Update the file header comment to drop any reference to "auto-injects ssh-tunnel-<stage>".

- [ ] **Step 4: Delete the `injectStageTunnelEdges` test blocks**

In `packages/stack/test/stage-chain.test.ts`, delete the entire `describe('injectStageTunnelEdges', ...)` and any test that imports `TUNNEL_FIX_ID`. Update the test file's import block to drop those names.

- [ ] **Step 5: Type-check**

Run: `pnpm --filter @factiii/stack check-types`
Expected: PASS.

- [ ] **Step 6: Run the full test suite**

Run: `pnpm --filter @factiii/stack test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A packages/stack/src/plugins/pipelines/factiii/scanfix/ssh-tunnel.ts \
            packages/stack/src/plugins/pipelines/factiii/index.ts \
            packages/stack/src/utils/stage-chain.ts \
            packages/stack/test/stage-chain.test.ts
git commit -m "refactor(stack): delete ssh-tunnel scanfix; tunnel is runtime-only

Tunnel lifecycle is owned by runStageChain (previous commit). The
ssh-tunnel-<stage> Fix and injectStageTunnelEdges helper are no longer
needed and only confused readers about whether the tunnel is config or
runtime."
```

---

## Task 8: Narrow `ReachVia` and add lock-in test

**Files:**
- Modify: `packages/stack/src/types/plugin.ts:39`
- Create: `packages/stack/test/reach-via.test.ts`
- Modify: `packages/stack/src/plugins/pipelines/aws/index.ts` (replace `via: 'api'` with `via: 'local'`)
- Modify: `packages/stack/src/plugins/pipelines/factiii/index.ts` (canReach already returns only `local` or unreachable — just remove dead `via:` literal types if present)

- [ ] **Step 1: Replace `via: 'api'` in AWS pipeline**

In `packages/stack/src/plugins/pipelines/aws/index.ts:220`:

```typescript
// Before
return { reachable: true, via: 'api' };

// After
return { reachable: true, via: 'local' };
```

(Functionally identical: AWS API operations run from the dev machine; the previous `'api'` distinction was cosmetic.)

- [ ] **Step 2: Write the lock-in test**

Write to `packages/stack/test/reach-via.test.ts`:

```typescript
/**
 * Lock-in test for ReachVia.
 *
 * The dev-direct architecture (docs/superpowers/specs/2026-04-25-...)
 * reduces routing to a single execution context: the dev machine. Every
 * canReach() returns either { reachable: true, via: 'local' } or
 * { reachable: false }. If anyone re-adds 'ssh' / 'workflow' / 'api' /
 * 'github-api' to the union, this file fails to compile.
 *
 * Type-only test — there is nothing to assert at runtime.
 */
import type { ReachVia, Reachability } from '../src/types/index.js';

// Compile-time assertion: ReachVia is exactly 'local'.
type Assert<T extends true> = T;
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ReachViaIsExactlyLocal = Assert<Equals<ReachVia, 'local'>>;

// Compile-time assertion: a Reachability value cannot be constructed with
// any disallowed via values. The @ts-expect-error directives MUST trigger;
// if any does not, the test is broken (the directive itself errors).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _disallowed: Reachability[] = [
  // @ts-expect-error 'ssh' is no longer a valid ReachVia
  { reachable: true, via: 'ssh' },
  // @ts-expect-error 'workflow' is no longer a valid ReachVia
  { reachable: true, via: 'workflow' },
  // @ts-expect-error 'api' is no longer a valid ReachVia
  { reachable: true, via: 'api' },
  // @ts-expect-error 'github-api' is no longer a valid ReachVia
  { reachable: true, via: 'github-api' },
];

describe('ReachVia lock-in (compile-time only)', () => {
  test('placeholder — real assertions are in the type system above', () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 3: Run the lock-in test (should fail to compile because ReachVia still has the wider union)**

Run: `pnpm --filter @factiii/stack check-types`
Expected: TYPE ERROR — `_ReachViaIsExactlyLocal` fails because `ReachVia` is wider than `'local'`. Also, the `@ts-expect-error` directives report "Unused @ts-expect-error" because the values they annotate currently *are* assignable.

- [ ] **Step 4: Narrow `ReachVia`**

In `packages/stack/src/types/plugin.ts`:

```typescript
// Before
export type ReachVia = 'local' | 'ssh' | 'workflow' | 'api' | 'github-api';

// After
export type ReachVia = 'local';
```

- [ ] **Step 5: Type-check**

Run: `pnpm --filter @factiii/stack check-types`
Expected: PASS. If errors arise, they're sites that still produce or pattern-match `'ssh' | 'workflow' | 'api' | 'github-api'`. Two known cases to fix at this step:
- `packages/stack/src/cli/scan.ts:269` — the conditional `reach.via !== 'local'` comparison: drop the entire `if (reach && reach.reachable && reach.via !== 'local') { ... }` branch (it's dead — `via` can only be `'local'` now).
- Same file, `displayProblems`: remove the `// Skip stages not scanned locally` block that checked `reach.via !== 'local'`.
- Same patterns in `fix.ts` (`reachability[stage]!.via === 'local'` branches: the `else` branch that pushed to `remoteStages` is now unreachable — the whole local/remote split collapses to a single list).

For each error site, simplify by collapsing the `via === 'local'` branch (always taken) and deleting the `else`/remote-handling branch. This is preparatory for Tasks 10–12, which rewrite scan/fix/deploy entirely; for now, just keep it compiling.

- [ ] **Step 6: Run the full test suite**

Run: `pnpm --filter @factiii/stack test`
Expected: PASS, including `reach-via.test.ts` and the existing `can-reach.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/stack/src/types/plugin.ts \
        packages/stack/test/reach-via.test.ts \
        packages/stack/src/plugins/pipelines/aws/index.ts \
        packages/stack/src/cli/scan.ts \
        packages/stack/src/cli/fix.ts \
        packages/stack/src/cli/deploy.ts
git commit -m "refactor(stack): narrow ReachVia to 'local'; collapse remote-stage branches

ReachVia drops 'ssh', 'workflow', 'api', 'github-api'. Every canReach
now returns { reachable: true, via: 'local' } or { reachable: false }.
AWS pipeline's via: 'api' becomes via: 'local' (functionally identical).
Adds reach-via.test.ts as a compile-time lock-in. CLI files have their
local/remote-split branches collapsed in preparation for the runStageChain
wiring that follows."
```

---

## Task 9: Add `canReach`-no-ssh assertion to the existing test

**Files:**
- Modify: `packages/stack/test/can-reach.test.ts`

- [ ] **Step 1: Add an assertion that no path returns disallowed `via` values**

Append to `packages/stack/test/can-reach.test.ts`:

```typescript
import FactiiiPipeline from '../src/plugins/pipelines/factiii/index.js';
import AWSPipeline from '../src/plugins/pipelines/aws/index.js';
import type { FactiiiConfig, Stage } from '../src/types/index.js';

describe('canReach — no remote via paths', () => {
  const stages: Stage[] = ['dev', 'staging', 'prod'];

  // Minimal config covering both pipelines' branches.
  const cfg: FactiiiConfig = {
    name: 'test',
    ansible: { vault_path: 'vault.yml', vault_password_file: '~/.vault_pass' },
    staging: { domain: 'staging.test.com' },
    prod: { domain: 'prod.test.com' },
    aws: { region: 'us-east-1' },
  } as unknown as FactiiiConfig;

  for (const stage of stages) {
    test('FactiiiPipeline.canReach(' + stage + ') returns local or unreachable', () => {
      const r = FactiiiPipeline.canReach(stage, cfg);
      if (r.reachable) {
        expect(r.via).toBe('local');
      } else {
        expect(typeof r.reason).toBe('string');
      }
    });

    test('AWSPipeline.canReach(' + stage + ') returns local or unreachable', () => {
      const r = AWSPipeline.canReach(stage, cfg);
      if (r.reachable) {
        expect(r.via).toBe('local');
      } else {
        expect(typeof r.reason).toBe('string');
      }
    });
  }
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @factiii/stack test test/can-reach.test.ts`
Expected: PASS (the type narrowing in Task 8 already guarantees this; the test is documentation/regression protection).

- [ ] **Step 3: Commit**

```bash
git add packages/stack/test/can-reach.test.ts
git commit -m "test(stack): assert canReach paths return only via:'local' or unreachable"
```

---

## Task 10: Wire `runStageChain` into `scan.ts`

This task replaces the per-stage filter/run loop in `scan.ts` with a single `runStageChain` invocation, then renders `StageChainResult`. Reachability checks remain (for showing "BLOCKERS" output), but the actual scan execution is delegated to the chain runner. Remote-stage delegation to `pipeline.scanStage` is deleted (no longer needed).

**Files:**
- Modify: `packages/stack/src/cli/scan.ts`

- [ ] **Step 1: Read the existing file once to anchor the rewrite**

Run: `wc -l packages/stack/src/cli/scan.ts` (currently ~705 lines, will shrink considerably).

- [ ] **Step 2: Rewrite the body of `scan()` to delegate to `runStageChain`**

In `packages/stack/src/cli/scan.ts`, replace the body of the `scan()` function (the section from "Determine which stages to scan" through "Display problems grouped by stage") with:

```typescript
  // Determine which stages to scan
  let stages: Stage[] = ['dev', 'staging', 'prod'];
  let targetStage: 'staging' | 'prod' | undefined;

  if (options.stages) {
    stages = options.stages;
    targetStage = options.targetStage;
  }
  else if (options.dev) stages = ['dev'];
  else if (options.staging) {
    stages = ['dev', 'staging'];
    targetStage = 'staging';
  }
  else if (options.prod) {
    stages = ['dev', 'prod'];
    targetStage = 'prod';
  }

  // (Existing dev_only auto-unlock block stays — leave as-is.)

  // Reachability check (drives BLOCKERS output and short-circuits unreachable stages).
  const plugins = (await loadPlugins(rootDir))!;
  const pipelinePlugins = getAllPipelinePlugins(plugins);

  const reachability: Record<string, Reachability> = {};
  for (const stage of stages) {
    if (stage === 'dev') {
      reachability[stage] = { reachable: true, via: 'local' };
      continue;
    }
    reachability[stage] =
      pipelinePlugins.length > 0
        ? checkReachability(pipelinePlugins, stage, config)
        : { reachable: true, via: 'local' };
  }
  const reachableStages = stages.filter((s) => reachability[s]?.reachable);

  // Collect all fixes (deduplicate, env-var fixes, OS-filter — same as before).
  const allFixes: Fix[] = [];
  const seenFixKeys = new Set<string>();
  for (const plugin of plugins) {
    for (const fix of plugin.fixes ?? []) {
      const key = fix.id + ':' + fix.stage;
      if (seenFixKeys.has(key)) continue;
      seenFixKeys.add(key);
      allFixes.push({ ...fix, plugin: plugin.id });
    }
    const envFixes = generateEnvVarFixes(plugin, rootDir, config);
    allFixes.push(...envFixes);
  }

  // OS filtering — keep the existing stageToOS construction (lines ~622-637).

  // Apply target-stage and OS filters.
  const filteredFixes = allFixes.filter((fix) => {
    if (targetStage && fix.targetStage && fix.targetStage !== targetStage) return false;
    if (fix.os) {
      const targetOS = stageToOS[fix.stage];
      if (targetOS) {
        const fixOSList = Array.isArray(fix.os) ? fix.os : [fix.os];
        if (!fixOSList.includes(targetOS)) return false;
      }
    }
    return true;
  });

  // Run the chain. applyFixes=false because this is scan.
  const { runStageChain } = await import('../utils/stage-chain.js');
  const chainResult = await runStageChain(filteredFixes, {
    config,
    rootDir,
    stages: reachableStages,
    applyFixes: false,
  });

  // Convert StageChainResult into the legacy ScanProblems shape so existing
  // callers (notably fix.ts during its transitional state, the JSON consumers,
  // anything that reads scan()'s return value) continue to work.
  const problems: ScanProblems = { dev: [], staging: [], prod: [] };
  for (const stage of stages) {
    const stageResult = chainResult.byStage.get(stage);
    if (!stageResult) continue;
    for (const fix of filteredFixes) {
      if (fix.stage !== stage) continue;
      const outcome = stageResult.outcomes.get(fix.id);
      if (outcome && outcome.issueDetected) {
        problems[stage].push(fix);
      }
    }
  }

  // Display problems grouped by stage (existing displayProblems function).
  displayProblems(problems, reachability, options);

  return problems;
}
```

- [ ] **Step 3: Delete the now-dead helpers**

The remote-stage delegation to `pipeline.scanStage` is no longer reachable. Delete:
- The `interface PipelinePluginInstance { scanStage(...) ... }` block.
- The `interface PipelinePluginClass` if it's only used by the deleted block.
- The "Remote stages: delegate to pipeline plugin" block at lines ~684-695.

Also drop the `localStages`/`remoteStages` separation logic (replaced by `reachableStages` above).

- [ ] **Step 4: Type-check**

Run: `pnpm --filter @factiii/stack check-types`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `pnpm --filter @factiii/stack test`
Expected: PASS. If a scan-related test asserts old behavior (e.g., "calls pipeline.scanStage"), update or delete that assertion.

- [ ] **Step 6: Commit**

```bash
git add packages/stack/src/cli/scan.ts
git commit -m "refactor(stack): scan.ts delegates stage execution to runStageChain

Replaces the per-stage local/remote split + per-fix scan loop with a
single runStageChain call. Pipeline.scanStage delegation is deleted —
all scans run on the dev machine, with remote state reached via the
tunnel that runStageChain owns. Reachability checks remain so the
BLOCKERS output still works."
```

---

## Task 11: Wire `runStageChain` into `fix.ts`

Mirrors Task 10. Replace `runLocalFixes` (the multi-pass loop) with a single `runStageChain` call (`applyFixes: true`), and delete `pipeline.fixStage` delegation.

**Files:**
- Modify: `packages/stack/src/cli/fix.ts`

- [ ] **Step 1: Replace `runLocalFixes` with a `runStageChain` call**

In `packages/stack/src/cli/fix.ts`, replace the entire `runLocalFixes` function (lines ~112-246) with a thin wrapper that calls `runStageChain` once with `applyFixes: true`, then translates `StageChainResult` into the legacy `FixResult` shape:

```typescript
import { runStageChain } from '../utils/stage-chain.js';
import { loadRelevantPlugins } from '../plugins/index.js';
import type { FactiiiConfig, FixOptions, FixResult, Stage, Reachability, Fix } from '../types/index.js';

async function runChainAsFix(
  options: FixOptions,
  reachableStages: Stage[],
): Promise<FixResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const config = (await import('../utils/config-helpers.js')).loadConfig(rootDir);

  // Build the fix list the same way scan.ts does (deduplicate + env-var fixes
  // + os/targetStage filter). Extract this into a shared helper if the duplication grows.
  const plugins = await loadRelevantPlugins(rootDir, config);
  const allFixes: Fix[] = [];
  const seen = new Set<string>();
  for (const plugin of plugins) {
    for (const fix of (plugin as { fixes?: Fix[] }).fixes ?? []) {
      const key = fix.id + ':' + fix.stage;
      if (seen.has(key)) continue;
      seen.add(key);
      allFixes.push({ ...fix, plugin: (plugin as { id: string }).id });
    }
  }

  const filtered = allFixes.filter((fix) => {
    if (options.targetStage && fix.targetStage && fix.targetStage !== options.targetStage) return false;
    return true;
  });

  const chain = await runStageChain(filtered, {
    config,
    rootDir,
    stages: reachableStages,
    applyFixes: true,
    onOutcome: (outcome, fix, stage) => {
      // Streaming progress: print each outcome as it lands.
      if (outcome.status === 'fixed') {
        console.log('  ✅ ' + fix.description);
      } else if (outcome.status === 'failed') {
        console.log('  ❌ ' + fix.description + (outcome.reason ? ' — ' + outcome.reason : ''));
      } else if (outcome.status === 'manual') {
        console.log('  📝 ' + fix.description);
      } else if (outcome.status === 'skipped') {
        console.log('  ⊘ ' + fix.description + ' — ' + (outcome.reason ?? 'skipped'));
      }
    },
  });

  // Translate StageChainResult → FixResult (legacy shape).
  const result: FixResult = { fixed: 0, manual: 0, failed: 0, fixes: [] };
  for (const stage of reachableStages) {
    const dag = chain.byStage.get(stage);
    if (!dag) continue;
    for (const [id, outcome] of dag.outcomes) {
      const fix = filtered.find((f) => f.id === id);
      if (!fix) continue;
      if (outcome.status === 'fixed') {
        result.fixed++;
        result.fixes.push({ id, stage, status: 'fixed', description: fix.description });
      } else if (outcome.status === 'manual') {
        result.manual++;
        result.fixes.push({
          id, stage, status: 'manual', description: fix.description, manualFix: fix.manualFix,
        });
      } else if (outcome.status === 'failed') {
        result.failed++;
        result.fixes.push({
          id, stage, status: 'failed', description: fix.description, error: outcome.reason,
        });
      }
      // 'ok' and 'skipped' are not surfaced in the legacy summary — same as before.
    }
  }
  return result;
}
```

In `fix()`, replace the call site `const result = await runLocalFixes({ ...options, targetStage }, localStages);` with `const result = await runChainAsFix({ ...options, targetStage }, reachableStages);`, where `reachableStages` is constructed exactly like in Task 10.

Delete the entire `for (const stage of remoteStages)` block at lines ~331-354 — `runStageChain` handles every stage uniformly.

Delete the now-unused `findPipelineForStage` helper, `PipelinePluginInstance` interface, and the `localStages`/`remoteStages` separation.

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @factiii/stack check-types`
Expected: PASS.

- [ ] **Step 3: Run the full test suite**

Run: `pnpm --filter @factiii/stack test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/stack/src/cli/fix.ts
git commit -m "refactor(stack): fix.ts delegates stage execution to runStageChain

Replaces runLocalFixes (multi-pass loop) and the remote pipeline.fixStage
delegation with a single runStageChain call. Output is streamed via
onOutcome; legacy FixResult shape preserved for downstream consumers."
```

---

## Task 12: Wire `runStageChain` into `deploy.ts`

`deploy.ts` runs scan → block on critical → call `pipeline.deployStage`. Under the new model, the "scan" step becomes a `runStageChain` call (with `applyFixes: true` to ensure prereqs are clean), and only then is `deployStage` invoked.

**Files:**
- Modify: `packages/stack/src/cli/deploy.ts`

- [ ] **Step 1: Replace the scan-then-deploy section with chain-then-deploy**

In `packages/stack/src/cli/deploy.ts`, find the section that calls `scan(...)` before `deployStage`. Replace with:

```typescript
import { runStageChain } from '../utils/stage-chain.js';

// ... inside deploy():

// Run prereq stages as a fix chain so anything dev/staging that's broken
// gets fixed (or surfaces) before we touch deployment artifacts.
const prereqStages: Stage[] = stage === 'prod' ? ['dev', 'staging'] : ['dev'];
// Build fix list same way scan.ts/fix.ts do — extract a shared helper if not already shared.
const plugins = await loadRelevantPlugins(rootDir, config);
const allFixes: Fix[] = [];
const seen = new Set<string>();
for (const plugin of plugins) {
  for (const fix of (plugin as { fixes?: Fix[] }).fixes ?? []) {
    const key = fix.id + ':' + fix.stage;
    if (seen.has(key)) continue;
    seen.add(key);
    allFixes.push({ ...fix, plugin: (plugin as { id: string }).id });
  }
}

const chain = await runStageChain(allFixes, {
  config,
  rootDir,
  stages: prereqStages,
  applyFixes: true,
});

if (chain.chainBroken) {
  console.error('\n[X] Prereq stage broken (' + chain.firstFailedStage + '). Fix and retry:');
  console.error('    npx stack fix');
  return { success: false, error: 'Prereq chain broken at ' + chain.firstFailedStage };
}

// Now call deployStage as before.
const PipelineClass = pipelinePlugin as unknown as PipelinePluginClass;
const pipeline = new PipelineClass(config);
const deployResult = await pipeline.deployStage(stage, options);
```

The exact placement depends on the rest of `deploy.ts`'s structure — read the file and slot the chain call where `scan(...)` is currently invoked. Keep all rollback/health-check/secret-management code that's currently after `deployStage`.

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @factiii/stack check-types`
Expected: PASS.

- [ ] **Step 3: Run the full test suite**

Run: `pnpm --filter @factiii/stack test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/stack/src/cli/deploy.ts
git commit -m "refactor(stack): deploy.ts uses runStageChain for prereqs

Replaces the legacy scan-and-deploy sequence with runStageChain
(applyFixes: true) over the prereq stages, then calls deployStage.
Prereq failures break before deployment artifacts are touched."
```

---

## Task 13: Rewrite `STANDARDS.md`

This task documents the final state. It does not change behavior; the previous twelve tasks already did.

**Files:**
- Modify: `packages/stack/STANDARDS.md`

- [ ] **Step 1: Replace the "Pipeline Categories — PIPELINES" section**

In `packages/stack/STANDARDS.md`, find the section starting with `### 1. PIPELINES` (around line 9). Replace its `Required Methods` and `Factiii Pipeline Routing` examples with the dev-direct version:

```markdown
**Required Methods:**

```typescript
// STATIC: Can this pipeline reach a stage from the dev machine?
//
// Under the dev-direct architecture, every command runs on dev.
// canReach() returns local-or-unreachable; the legacy 'ssh' / 'workflow'
// routing values no longer exist.
static canReach(stage: Stage, config: FactiiiConfig): Reachability {
  // Returns: { reachable: true, via: 'local' }
  // Or:      { reachable: false, reason: '...' }
}

// INSTANCE: Deploy to a stage. The CLI runs runStageChain first (in
// fix mode) and only invokes this when prereqs are clean.
async deployStage(stage: Stage, options: DeployOptions): Promise<DeployResult> {
  return this.runLocalDeploy(stage, options);
}
```

The Four Stages table is replaced by:

| Stage | Description |
|-------|-------------|
| `dev` | Dev machine. All scanfixes run here, including ones that touch the vault or write SSH keys. |
| `staging` | Staging server. Scanfixes run from dev; remote commands route via `serverExec` over the SSH tunnel. |
| `prod` | Production server. Same as staging. |

Note: the legacy `secrets` stage is folded into `dev`. Vault unlocking, key extraction, and `.env` writing are now `stage: 'dev'` fixes ordered with `requires` chains.
```

- [ ] **Step 2: Replace the "Stage Execution" section**

Replace the `Stage Execution` section (Environment Variables, How Commands Work, Commands Are Dumb, Workflow Pattern, Stage Batching, Fix Function Rules subsections) with:

```markdown
## Stage Execution

### How Commands Work

1. User specifies stage: `--dev`, `--staging`, `--prod` (or no flag = all stages).
2. The command (scan/fix/deploy) collects all plugin fixes.
3. The command calls `runStageChain(fixes, { stages, applyFixes, ... })`.
4. The chain runs each stage as a DAG. For staging/prod it opens an SSH tunnel before the DAG and closes it after.
5. Per-fix outcomes (`ok`/`fixed`/`failed`/`skipped`/`manual`) are returned as a `StageChainResult` and rendered as the end-of-run summary.

### The serverExec Contract

When a scanfix's `scan` or `fix` function needs to issue a shell command, it calls `serverExec(stage, cmd)`:

- `stage === 'dev'` → local `execSync`.
- `stage === 'staging' | 'prod'` → `tunnelExec` over the cached per-stage SSH tunnel that `runStageChain` opened on stage entry.

Returns trimmed stdout. Throws on non-zero exit. Scanfix authors do not call `tunnelExec` or `execSync` directly.

### Scanfix Authoring Rules

- **`scan` returns `true` for "issue detected."** Throw only for genuine surprises (filesystem error, malformed config the scan reasonably expected to be valid).
- **`fix` returns `true` if it resolved the issue, `false` if it could not.** Do not catch errors and return `true` to silence them — let them propagate.
- **Use `serverExec(stage, cmd)` for all shell commands.** Never call `execSync` directly when you mean "run this on the target stage."
- **Order with `requires`.** Within a stage, list prereq fix ids in `requires`. The DAG runner topo-sorts and skip-cascades on prereq failure.
- **Use `os` to filter by target server type.** Cross-OS scanfixes either declare `os: ['mac', 'ubuntu']` and write commands that work on both, or duplicate per-OS with single-OS `os` filters.
- **Never `process.exit` inside scan or fix.** Return false or throw.
- **Never check `process.env.GITHUB_ACTIONS` or `FACTIII_ON_SERVER` inside scan or fix.** Scanfixes always run on the dev machine.
```

- [ ] **Step 3: Delete the workflow-pattern bash block**

Delete the section starting `### Workflow Pattern (ultra-thin)` through the end of that subsection — workflows no longer execute `npx stack` server-side. CI workflows that build/test PRs are unaffected and live in `.github/workflows/`; STANDARDS does not need to describe them.

- [ ] **Step 4: Update the §Plugin Categories — PIPELINES → Factiii Pipeline Routing example**

Replace the example block (lines ~58-86) with:

```typescript
static canReach(stage: Stage, config: FactiiiConfig): Reachability {
  switch (stage) {
    case 'dev':
      return { reachable: true, via: 'local' };

    case 'staging':
    case 'prod': {
      const envs = getEnvironmentsForStage(config, stage);
      const allExample = Object.values(envs).every(
        (e) => !e.domain || e.domain.toUpperCase().startsWith('EXAMPLE'),
      );
      const hasAws = Object.values(envs).some((e) => !!e.config || !!e.access_key_id);
      if (allExample && !hasAws) {
        return { reachable: false, reason: stage + ' domain is still a placeholder' };
      }
      return { reachable: true, via: 'local' };
    }
  }
}
```

(No SSH-key probing, no GITHUB_TOKEN fallback — the tunnel itself is opened by `runStageChain` on stage entry, and the SSH key is fetched lazily via `findSshKeyForStage`.)

- [ ] **Step 5: Read the doc top-to-bottom**

Run: `cat packages/stack/STANDARDS.md | wc -l` (sanity check on size — should be smaller than before).

Read the document end-to-end and fix any remaining contradictions, dangling references to the deleted sections, or "GITHUB_ACTIONS" / "via: 'ssh'" / "via: 'workflow'" / "secrets stage" mentions.

- [ ] **Step 6: Commit**

```bash
git add packages/stack/STANDARDS.md
git commit -m "docs(stack): rewrite STANDARDS.md for dev-direct architecture

Documents the new contract: canReach returns local-or-unreachable;
serverExec is the single command-routing primitive; secrets is folded
into dev; tunnel is a runtime resource owned by runStageChain. Drops
the workflow-pattern section (workflows no longer execute npx stack
server-side) and the GITHUB_ACTIONS routing rules."
```

---

## Acceptance gate (matches spec §8)

After all 13 tasks, verify:

- [ ] All existing tests pass: `pnpm --filter @factiii/stack test`
- [ ] New tests added in this plan are green: `server-exec.test.ts`, `stage-order.test.ts`, `reach-via.test.ts`, the tunnel-lifecycle additions to `stage-chain.test.ts`, the no-remote-via assertions in `can-reach.test.ts`.
- [ ] `STANDARDS.md` rewrite is in place (no `via: 'ssh'`, no `via: 'workflow'`, no "secrets stage" except in migration notes).
- [ ] `runStageChain` is the execution path for `scan.ts` / `fix.ts` / `deploy.ts`. Verify: `grep -n "runLocalFixes\|pipeline\\.scanStage\|pipeline\\.fixStage" packages/stack/src/cli/` returns nothing.
- [ ] `scanfix/ssh-tunnel.ts` is gone: `! [ -f packages/stack/src/plugins/pipelines/factiii/scanfix/ssh-tunnel.ts ]`.
- [ ] `injectStageTunnelEdges` and `TUNNEL_FIX_ID` are gone: `grep -rn "injectStageTunnelEdges\|TUNNEL_FIX_ID" packages/stack/src/` returns nothing.

If any of these fail, return to the corresponding task and complete the missing step before declaring the spec landed.

---

## Out of scope (reminder for the executor)

- **Do not** start migrating individual scanfixes off `process.env.GITHUB_ACTIONS` guards — that is the migration spec's job. Those guards become dead code under the new model but removing them safely requires per-fix analysis.
- **Do not** retire `ssh-helper.ts` or refactor `deployStage` internals onto `serverExec` — also migration territory.
- **Do not** design new scanfixes (multi-repo discovery, sync-verification, `stack.yml` delivery) — each gets its own follow-on spec.
- **Do not** add a renderer for the dev-side summary beyond the streaming `onOutcome` print in Task 11 — output formatting is a follow-on concern.
