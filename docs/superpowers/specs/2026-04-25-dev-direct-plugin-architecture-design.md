# Dev-Direct Plugin Architecture — Design

**Date:** 2026-04-25
**Status:** Draft (pending user review)
**Scope:** Architecture only. Migration of existing scanfixes and new scanfixes (multi-repo discovery, sync-verification, stack.yml delivery) are explicit follow-on specs.

---

## TL;DR

`@factiii/stack` runs entirely on the dev machine. Staging and prod are reached through a per-stage SSH tunnel that the chain runner opens and closes around each remote stage. Scanfixes issue commands through one helper, `serverExec(stage, cmd)`, which routes to local `execSync` for `dev` and `tunnelExec` for `staging` / `prod`. Nothing else changes about how a scanfix is authored. STANDARDS.md is rewritten to match.

The ambition is small: lock in the contract the in-flight code is already half-implementing, and stop forcing every scanfix to branch on `process.env.GITHUB_ACTIONS` to decide what context it's in.

---

## 1. Goals

- One execution context. Every `npx stack` invocation runs on the dev machine; scanfixes never run server-side.
- One routing primitive. Scanfixes call `serverExec(stage, cmd)`. The framework decides local vs tunneled.
- One ordering primitive. `Fix.requires` orders fixes within a stage; the stage chain orders across stages.
- One summary. End of run, the dev machine has a `StageChainResult` with every fix's outcome.
- Server stays minimal. sshd + Docker. No Node, no `@factiii/stack`, no git on prod.

## 2. Non-goals (deliberate, deferred to other specs)

- Migrating the ~30 existing scanfixes off `process.env.GITHUB_ACTIONS` guards.
- Retiring `ssh-helper.ts` and the legacy `via: 'ssh'` deploy paths.
- Removing Node / git from prod (the in-flight branch handles that).
- New scanfixes — multi-repo discovery, sync-verification, `stack.yml` delivery from dev.
- The renderer / UX of the dev-side summary. Data shape is in scope; presentation is not.
- Workflow path's fate for PR-CI builds. Adjacent decision; can ride alongside.

---

## 3. Architecture

Three principles, in priority order.

### 3.1 Dev is the only execution context

`canReach(stage)` returns `{reachable: true, via: 'local'}` or `{reachable: false, reason}`. The `ReachVia` union shrinks to just `'local'`. `via: 'ssh'` and `via: 'workflow'` are deleted. The CLI never SSHes server-side to invoke `npx stack` again.

### 3.2 Stage drives command routing

A scanfix's scan or fix function issues commands by calling `serverExec(stage, cmd)`. For `stage: 'dev'`, the helper is local `execSync`. For `stage: 'staging' | 'prod'`, it is `tunnelExec` against the cached per-stage tunnel handle. The author writes one shape; the framework provides the rest.

### 3.3 `requires` is the only ordering primitive

Within a stage, the DAG runner topo-sorts by `Fix.requires` and skip-cascades on prereq failure. Across stages, the chain runner runs `dev → staging → prod` in order; if a stage breaks, downstream stages auto-skip with a shared reason. Plugin authors compose ordering by listing prereq ids; the framework does the rest.

### 3.4 Three stages, not four

`STAGE_ORDER === ['dev', 'staging', 'prod']`. The legacy `secrets` stage collapses into `dev`. Vault unlocking, SSH-key extraction, AWS-credentials writing, and `.env` file generation are dev-machine operations that happen to involve ansible encryption — they become `stage: 'dev'` fixes with explicit `requires` chains:

```
vault-password-file → vault-unlocked → staging-ssh-key-to-disk → staging-env-file
                                    ↘ prod-ssh-key-to-disk    → prod-env-file
                                    ↘ aws-credentials-to-disk
```

STANDARDS stops calling secrets an environment.

### 3.5 Server stays minimal

sshd + Docker only. Dev assembles final `docker-compose.yml` and `nginx.conf` locally and `scp`s them. When a server hosts multiple repos, dev queries `~/.factiii/*/stack.yml` via `tunnelExec`, merges locally, ships the merged result back. (Multi-repo discovery scanfix design lives in its own spec.)

---

## 4. Components

### 4.1 Already in the repo (kept; spec freezes their roles)

| Component | Responsibility | Location |
|---|---|---|
| `Fix` type | Scanfix shape — `{id, stage, severity, scan, fix, manualFix, os?, requires?, serializeOn?}`. Unchanged. | `src/types/plugin.ts` |
| `runFixDAG` | Runs a `Fix[]` as a DAG. Topo-sort by `requires`, skip-cascade on prereq failure, returns `DAGResult`. | `src/utils/dag-runner.ts` |
| `runStageChain` | Runs each stage's DAG in `STAGE_ORDER`. Cross-stage gate: if stage N is broken, stages N+1..end skip-result. | `src/utils/stage-chain.ts` (modified — see 4.2) |
| `openTunnel` / `tunnelExec` / `closeTunnel` / `getTunnel` | Per-stage OpenSSH ControlMaster multiplexer. One handshake per stage; subsequent commands reuse the channel. | `src/utils/ssh-tunnel.ts` |

### 4.2 New / modified by this spec

| Component | Responsibility | Location |
|---|---|---|
| `serverExec(stage, cmd)` | Single routing primitive for shell commands. `stage='dev'` → local `execSync`. `stage='staging' \| 'prod'` → `tunnelExec` via `getTunnel(stage)`; throws clearly if no tunnel cached. Returns trimmed stdout; throws on non-zero exit. **Synchronous shape, mirrors `execSync`.** | `src/utils/server-exec.ts` (new) |
| `Reachability` shrunk | `ReachVia` becomes just `'local'`. `canReach` returns `{reachable: true, via: 'local'}` or `{reachable: false, reason}`. | `src/types/plugin.ts` (edit) |
| Stage chain wiring | `scan.ts`, `fix.ts`, `deploy.ts` invoke `runStageChain` instead of the existing multi-pass loop. The old loop is deleted. | `src/cli/{scan,fix,deploy}.ts` (edit) |
| `STAGE_ORDER` narrowed | `['dev','staging','prod']`. The `'secrets'` value disappears from the `Stage` union. | `src/utils/stage-chain.ts`, `src/types/plugin.ts` |
| Tunnel lifecycle in chain runner | When `runStageChain` enters `staging` or `prod`, it calls `openTunnel(stage, envConfig, keyPath)` *before* invoking the stage's DAG and `closeTunnel` after. Key path comes from `findSshKeyForStage(stage, config.name)`. If `openTunnel` throws, the entire stage's fixes synthesize as skip-results with the tunnel error in `reason`; `firstFailedStage` is set; downstream stages auto-skip. | `src/utils/stage-chain.ts` (extended) |
| Injectable tunnel functions on `runStageChain` | `runStageChain` accepts an optional `tunnel?: { openTunnel, closeTunnel }` parameter. Production callers omit it and get the real implementation; tests pass a fake registry. Avoids module-level monkey-patching in tests. | `src/utils/stage-chain.ts` (extended) |
| `STANDARDS.md` rewrite | New sections: "Dev-Direct Execution", "The serverExec Contract", "Three Stages", "Scanfix Authoring Rules". Deleted: `via: 'ssh'`, `via: 'workflow'`, `GITHUB_ACTIONS` routing variables, the workflow-pattern bash block. | `packages/stack/STANDARDS.md` |

### 4.3 Deleted by this spec

| Component | Why |
|---|---|
| `src/plugins/pipelines/factiii/scanfix/ssh-tunnel.ts` | The tunnel was never fix-shaped — opening a connection isn't "applying a fix to project state." Lifecycle moves into `runStageChain`. |
| `injectStageTunnelEdges` in `stage-chain.ts` | No longer needed; tunnel is a runtime resource, not a `requires` prereq. |

### 4.4 Component dependency picture

```
scan.ts / fix.ts / deploy.ts
        │
        ▼
   runStageChain  ──► (per stage, in order)
        │                 │
        │                 ▼
        │           open tunnel (staging/prod only)
        │                 │
        │                 ▼
        │             runFixDAG  ──► individual Fix.scan / Fix.fix
        │                 │                  │
        │                 │                  ▼
        │                 │           serverExec(stage, cmd)
        │                 │                  │
        │                 │       dev ───────┴────── staging/prod
        │                 │       │                       │
        │                 │   execSync               tunnelExec
        │                 │                               │
        │                 ▼                          getTunnel(stage)
        │           close tunnel
        ▼
  StageChainResult
        │
        ▼
  end-of-run summary
```

### 4.5 Out of scope as components

- Renderer / output module. Data shape is the contract; presentation is its own work.
- Per-OS command builders on server plugins. Scanfixes write their own command strings; cross-OS fixes use the `os` filter or duplicate.
- A `serverExecAsync` variant. Sync is enough until something demonstrably needs async.
- Migration sequencing for existing scanfixes.

---

## 5. Data flow

### 5.1 Flow A — `npx stack scan` (default, all stages)

1. CLI loads config + plugins; builds combined `Fix[]` filtered by `os` against each environment's `server` field.
2. CLI calls `runStageChain(fixes, {stages: ['dev','staging','prod'], applyFixes: false, config, rootDir})`.
3. Chain runs `dev` first. Every `Fix.scan` is invoked. `Fix.fix` is not (scan mode). Issues become `status: 'manual'` (with `manualFix` as reason) or `status: 'ok'`.
4. If any dev fix is `failed` or critical-`manual`, staging and prod are skip-resulted with `reason: 'prior stage (dev) failed'`. Otherwise:
5. Chain enters `staging`. Runner calls `openTunnel('staging', ...)`. Staging DAG runs; every `serverExec('staging', cmd)` resolves through `tunnelExec`. `closeTunnel` after.
6. Same for `prod`.
7. CLI receives `StageChainResult` and renders the summary.

### 5.2 Flow B — `npx stack scan --staging`

`runStageChain(fixes, {stages: ['dev','staging'], applyFixes: false, ...})`. The chain still runs `dev` first — staging cannot be authoritatively scanned with stale dev state. **Behaviorally symmetric with Flow C** (fix mode) because the tunnel lifecycle no longer depends on `applyFixes`.

### 5.3 Flow C — `npx stack fix --staging`

Identical to 5.2 with `applyFixes: true`. Each fix's scan runs first; if scan returns true, fix runs. The DAG runner is the only place that branches on `applyFixes`; the chain runner's tunnel lifecycle is identical for scan and fix modes.

### 5.4 Flow D — `npx stack deploy --staging`

1. CLI calls `runStageChain(fixes, {stages: ['dev','staging'], applyFixes: true, ...})` to ensure all prereqs are clean.
2. If the chain is broken, CLI prints summary and stops. Deploy never runs.
3. If clean, CLI calls `pipeline.deployStage('staging', options)`. The deploy step's *internals* — how it SSHes for `scp` / `docker compose up` / etc. — are unchanged in scope by this spec; that migration belongs to the follow-on spec that retires `ssh-helper.ts`. What this spec guarantees is that the chain-runner has finished and closed its tunnel cleanly before `deployStage` is invoked, so there's no shared-tunnel ambiguity between phases.
4. Deploy returns a `DeployResult`. CLI renders combined summary: `StageChainResult` from the prereq chain plus the deploy step's outcome.

### 5.5 Summary data shape (frozen)

```typescript
interface StageChainResult {
  byStage: Map<Stage, DAGResult>;
  chainBroken: boolean;
  firstFailedStage: Stage | null;
}

interface DAGResult {
  outcomes: Map<string /* fixId */, FixOutcome>;
  orderedIds: string[];
  hasFailures: boolean;
  hasSkipped: boolean;
}

interface FixOutcome {
  id: string;
  status: 'ok' | 'fixed' | 'failed' | 'skipped' | 'manual';
  reason?: string;
  issueDetected: boolean;
  durationMs: number;
}
```

Spec freezes this shape. Renderer concerns (terminal output, future JSON file, future dashboard) consume this data; the data is the contract, not the presentation. Capturing per-command stdout from `serverExec` is intentionally out of scope — scanfixes that want to surface remote output put the relevant snippet in `FixOutcome.reason`.

---

## 6. Error handling

### 6.1 Outcome status taxonomy

| Status | Meaning | Cascade |
|---|---|---|
| `ok` | Scan returned false (no issue). | None. |
| `fixed` | Scan returned true; fix returned true. | None. |
| `failed` | Scan threw, fix threw, fix returned false, or `openTunnel` threw for the whole stage. | Within stage: dependents marked `skipped`. Across stages: downstream stages skip-resulted. |
| `skipped` | A `requires` prereq was `failed` or `skipped`, or a prior stage broke the chain, or `requires` listed an unknown id. | Dependents in the same DAG are also `skipped`. |
| `manual` | Scan returned true; no fix function or `applyFixes: false`. Reason carries `manualFix`. | Cross-stage: `manual` + `severity: 'critical'` breaks the chain. Non-critical `manual` does not break. Within stage: never cascades. |

### 6.2 Within-stage cascade (DAG runner — already coded)

- A fix is `skipped` if any id in `requires` is currently `failed` or `skipped`. Reason: `'prereq <id> failed'` or `'prereq <id> skipped'`.
- A fix with a `requires` id absent from the loaded fix set is `skipped` with reason `'unknown prereq id(s): <list>'`. Typos surface as visible skips, not crashes.
- `manual` outcomes never cascade-skip dependents.

### 6.3 Cross-stage gate (chain runner — already coded)

A stage is "broken" iff any outcome is `failed` or any outcome is `manual` with `severity: 'critical'`. When stage N is broken, every fix in stages N+1..end is synthesized as `skipped` with `reason: 'prior stage (<N>) failed'`. The runner does not even open the next stage's tunnel.

### 6.4 Tunnel-related errors (new in this spec)

- `openTunnel` throws → the entire stage's fixes are skip-resulted with `reason: 'tunnel open failed: <error>'`. `firstFailedStage` is set to that stage. Downstream stages auto-skip.
- A tunnel that dies mid-stage (network drop, server reboot) → individual `serverExec` calls throw; the in-flight fix gets `status: 'failed'`; subsequent fixes in the same stage attempt and each independently fails on their own `serverExec`. The runner is single-threaded; the cost is bounded. No "stop the whole stage on first tunnel-dead error" optimization until it is observed in practice.
- SIGINT / SIGTERM during a run → process-exit handler in `ssh-tunnel.ts` closes any open masters (best-effort). In-flight `spawnSync` is interrupted. Whatever fix was running shows as `failed` if the runner gets to record it. No graceful resume.

### 6.5 Author contract (`STANDARDS.md` will state these as rules)

- `scan` returns `true` to mean "issue detected." It does not throw for that. Throw only for genuine surprises (filesystem error, invalid config the scan reasonably expected to be valid).
- `fix` returns `true` if it resolved the issue, `false` if it could not. Do not catch errors and return `true` to silence them — let them propagate so the runner can record `failed`.
- `serverExec` throws on non-zero remote exit. When the absent case is normal (e.g. `docker ps -q -f name=foo` matching nothing), use commands that signal via empty stdout, not via exit code.
- Never `process.exit` inside scan or fix. Return false or throw.

### 6.6 Things deliberately not solved

- Resumable runs / partial replay. A failed run starts over. Idempotent fixes (already a STANDARDS rule) make repetition safe.
- Verbose / quiet output flags. Renderer concern.
- Automatic retry on transient SSH errors. Chain reports failure; user re-runs.

---

## 7. Testing

### 7.1 Existing tests (must stay green)

- `dag-runner.test.ts` — topo sort, `requires` cascade, scan/fix error capture, unknown-prereq handling.
- `stage-chain.test.ts` — cross-stage gating, skip-result synthesis.
- `can-reach.test.ts` — reachability decisions.
- `stack-version-pin-scanfix.test.ts`, `prod-generators.test.ts` — adjacent dev-side machinery.

### 7.2 New tests added by this spec

| Module | Cases |
|---|---|
| `serverExec(stage, cmd)` | (a) `stage='dev'` invokes `execSync` and returns trimmed stdout. (b) `stage='staging' \| 'prod'` invokes `tunnelExec` against the cached handle. (c) Throws clearly when called for a remote stage with no tunnel cached. (d) Non-zero exit propagates as a throw. |
| `runStageChain` (additions) | (a) Tunnel opens on entry to a remote stage and closes on exit. (b) `openTunnel` throwing → entire stage's fixes synthesized into skip-results with tunnel error in reason; `firstFailedStage` set; downstream stages auto-skip. (c) Tunnel is not opened when a remote stage has zero matching fixes. (d) `STAGE_ORDER === ['dev','staging','prod']`. |
| `canReach` | Asserts no path returns `via: 'ssh'` or `via: 'workflow'`. |

### 7.3 Mocking strategy

- `openTunnel` / `closeTunnel` / `tunnelExec` are mocked at module level; tests inject a fake registry. No real SSH in unit tests.
- `execSync` is mocked for `serverExec` dev-path tests.
- `runStageChain` accepts an optional injectable tunnel-functions object so tests do not have to monkey-patch the SSH module. Production callers pass nothing and get the real implementation.

### 7.4 Lock-in tests

Two cheap tests that protect the architecture from drift:

1. **Type-narrowing lock for `ReachVia`.** A typecheck-only test file that fails to compile if anyone re-adds `'ssh'` or `'workflow'` to the union.
2. **`STAGE_ORDER` freeze.** Runtime assertion that `STAGE_ORDER` is exactly `['dev','staging','prod']`. Adding a stage forces revisiting this spec.

### 7.5 Smoke tests (not merge gates here)

A tunnel-against-live-staging test belongs to the migration spec — it requires a real target server. For this spec, unit-level coverage is sufficient; the architecture is provably correct against a mocked tunnel registry.

### 7.6 Out of scope for testing in this spec

- Static lint for `process.env.GITHUB_ACTIONS` in scanfix files — migration spec.
- Renderer / summary output snapshot tests — renderer is out of scope.
- Per-scanfix migration tests — each migration spec carries its own.

---

## 8. Acceptance gate

The spec is landed when:

1. All existing tests pass.
2. New tests in §7.2 added and green.
3. `STANDARDS.md` rewrite merged.
4. `runStageChain` is wired into `scan.ts` / `fix.ts` / `deploy.ts`; the multi-pass loop is deleted.
5. `src/plugins/pipelines/factiii/scanfix/ssh-tunnel.ts` and `injectStageTunnelEdges` are deleted; tunnel lifecycle moves into `runStageChain`.

The largest mechanical change is item 5 — about fifty lines moved from a scanfix file into the chain runner. The largest documentation change is item 3.

---

## 9. Follow-on specs that consume this one

- **Migration spec.** Sequencing for cutting existing scanfixes onto `serverExec`; retiring `process.env.GITHUB_ACTIONS` guards; retiring `ssh-helper.ts`. Includes a static lint or grep guard for the forbidden patterns. Has its own real-SSH smoke tests.
- **New scanfix specs.** Multi-repo discovery (dev queries `~/.factiii/*/stack.yml` over the tunnel); sync-verification (dev checks remote stack/docker versions); `stack.yml` delivery from dev. Each is a small spec; each consumes this architecture without re-litigating it.
- **Renderer spec (if needed).** A concrete UX for the end-of-run summary, a JSON file output, and any dashboard integration. Optional and demand-driven.
