# Triggering & Stage Minimization

Dev is the single trigger source. Staging and prod are deploy targets, not origin points. The goal: keep the dev machine authoritative so staging/prod can stay minimal.

## Dev as Single Trigger

| Action | Triggers from | Runs on remote |
|--------|---------------|----------------|
| `npx stack fix --staging` | Dev | scan/fix on staging via SSH |
| `npx stack deploy --staging` | Dev | docker build + compose up |
| `npx stack fix --prod` | Dev | scan/fix on prod via SSH |
| `npx stack deploy --prod` | Dev | compose pull + up (image from ECR) |

The pipeline plugin's `canReach(stage)` decides routing (`STANDARDS.md` Plugin Categories). SSH execution is the final gate — if dev can reach, dev controls the stage.

## Installed Surface Per Stage

| Stage | Node | Stack | Git | Docker | Why |
|-------|------|-------|-----|--------|-----|
| Dev | Yes | Yes | Yes | Yes | Source of truth, runs all scans/fixes |
| Staging | Yes | Yes | Yes | Yes | Builds from source (`requiresFullRepo=true`) |
| Prod | No | No | No | Yes | Pulls pre-built images from ECR |

Dev assembles the prod `docker-compose.yml` and `nginx.conf` locally (`generateProdCompose` / `generateProdNginx`) and `scp`s them to `~/.factiii/<repo>/` via the per-stage SSH tunnel. Migrations are run with `docker exec` against the already-pulled image — no `npx stack` on prod.

## Sync Verification (Staging Only)

Staging still has stack installed locally (it's the build host), so staging can drift from dev. Pair every staging-side execution with a sync check:

```typescript
// staging-stack-in-sync
scan: SSH, run `npx stack --version`, compare with local
fix:  SSH and `npm install -g @factiii/stack@<dev-version>`
```

Prod has no stack to drift; no equivalent check is needed there.

## Why Staging Keeps Git

Staging builds from source, so source must reach staging. Two options:

1. **`git clone/pull`** (today) — `.git/` present, `git log -1` answers "what's actually deployed"
2. **`git archive | ssh tar -x`** — snapshot only, lighter, but loses on-host debugging

Option 1 wins: git is small, on-host commit visibility is genuinely useful when debugging staging.

## Why Prod Loses Node/Stack/Git

Prod flow (`flow.md`):

1. Dev generates `docker-compose.yml` + `nginx.conf` locally and `scp`s them to `~/.factiii/<repo>/`
2. SSH receives `docker login`, `compose pull`, `compose up -d`
3. Docker pulls image from ECR; container starts

No source, no build, no merge step on prod. Any prod-side check (e.g. `aws/scanfix/docker.ts`, `aws/scanfix/db-replication.ts`) runs from dev via the per-stage SSH tunnel and `serverExec('prod', cmd)`.

## Rules

- **Never expand prod's installed surface.** New scanfixes targeting prod must run from dev via SSH, not server-side.
- **Staging may grow** (it's already the build host) — but only when the alternative is materially worse on dev.
- **Every remote scanfix needs a sync-verification scanfix** so version drift is a blocker, not a silent bug.
- **`stack.local.yml` gates dev-machine behavior** (`dev_only`, `claude_skills`). Server stages never read it.
