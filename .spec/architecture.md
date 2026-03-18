# Architecture

## Plugin Categories
```
PIPELINES  — CI/CD routing (factiii, aws)
SERVERS    — OS commands, not deployment targets (mac, ubuntu, windows, amazon-linux)
FRAMEWORKS — App-level plugins (expo, prisma-trpc)
ADDONS     — Extensions (server-mode, openclaw)
```

## Directory Layout
```
src/cli/          — Command entry points (scan, fix, deploy, secrets, db, ops, backup)
src/generators/   — File generators (compose, nginx, stack-auto, stack-yml)
src/plugins/
  pipelines/factiii/  — Main pipeline: index.ts, scanfix/, workflows/
  pipelines/aws/      — AWS provisioning: scanfix/, utils/, policies/
  servers/            — OS plugins
  frameworks/         — Framework plugins
  addons/             — Extension plugins
  interfaces/         — Base classes (pipeline.ts, server.ts, framework.ts, addon.ts)
src/utils/        — ssh-helper, ansible-vault-secrets, config-helpers
src/types/        — config.ts, plugin.ts, cli.ts
src/constants/    — Config file paths, reserved keys
```

## Stages & Routing
Stages: `dev` | `secrets` | `staging` | `prod`

`canReach(stage, config)` returns `{ reachable: true, via }` or `{ reachable: false, reason }`.

| Stage | Routing |
|-------|---------|
| dev, secrets | Always `local` |
| staging, prod | SSH key (`~/.ssh/{stage}_deploy_key`) → vault password fallback → AWS local → unreachable |
| AWS environments | Always `local` (provisioning from dev machine) |

## Deploy Flow
1. `deploy.ts` calls pipeline's `deployStage(stage, options)`
2. Pipeline calls `canReach(stage, config)`
3. If `via: 'local'` → execute directly
4. If `via: 'ssh'` → SSH to server, run `npx stack deploy --{stage}` there
6. If `reachable: false` → return error

## Scan Flow (two-phase bootstrap)
1. `scan.ts` runs bootstrap fixes first (create missing config files)
2. Re-loads config
3. Runs all remaining scanfixes

## Workflow Pattern (ultra-thin)
```yaml
ssh -i ~/.ssh/deploy_key "$USER@$HOST" \
  "GITHUB_ACTIONS=true npx stack deploy --staging"
```
Only: trigger + secrets + SSH + CLI invocation. No setup/clone/install/build logic.
