---
"@factiii/stack": minor
---

Dev-direct plugin execution architecture

- Single execution context: every `npx stack` invocation runs on dev. Staging/prod scanfixes reach the server through a per-stage SSH tunnel that `runStageChain` opens and closes around each remote stage's DAG.
- New `serverExec(stage, cmd)` — single command-routing primitive: local `execSync` for dev, `tunnelExec` for staging/prod via the cached tunnel handle.
- `Stage` union narrowed to `'dev' | 'staging' | 'prod'`. The legacy `secrets` stage folds into `dev` (vault unlocking, key extraction, .env writing become `stage: 'dev'` fixes ordered with `requires` chains). `--secrets` flag removed from `scan` and `fix`; `deploy --secrets <action>` for vault management is unchanged.
- `ReachVia` narrowed to `'local'` only. `canReach()` returns `{ reachable: true, via: 'local' }` or `{ reachable: false, reason }` — no more `via: 'ssh' | 'workflow' | 'api' | 'github-api'`.
- `runStageChain` owns SSH tunnel lifecycle. The `ssh-tunnel-<stage>` scanfix and `injectStageTunnelEdges` helper are deleted.
- `scan.ts` / `fix.ts` / `deploy.ts` delegate stage execution to `runStageChain`. The multi-pass loop and `pipeline.scanStage` / `pipeline.fixStage` delegation paths are gone.
- `npx stack deploy --<stage>` now runs the upstream-stage fix chain (`applyFixes: true`) before touching deployment artifacts. `deploy --prod` requires staging to be reachable.
- Lock-in tests for `STAGE_ORDER` and `ReachVia` prevent silent drift; `STANDARDS.md` rewritten to match.
