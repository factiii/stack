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
| Prod (target) | No | No | No | Yes | Pulls pre-built images from ECR |
| Prod (today) | Yes | Yes | No | Yes | `generate-all.ts` runs server-side |

**Today vs. target:** prod still needs Node + stack to merge configs server-side. Target state moves config merging to dev (build merged `docker-compose.yml` on dev, scp to prod) so prod's only requirement is Docker.

## Sync Verification (Required Scanfix)

Because dev triggers everything, dev's stack version is what matters. Staging/prod can lag — but only if drift is *visible*. Every remote-executing scanfix must be paired with a sync check:

```typescript
// staging-stack-in-sync (and prod-stack-in-sync)
scan: SSH, run `npx stack --version`, compare with local
fix:  SSH and `npm install -g @factiii/stack@<dev-version>`
```

Without this, "dev triggers everything" silently breaks the moment versions diverge.

## Why Staging Keeps Git

Staging builds from source, so source must reach staging. Two options:

1. **`git clone/pull`** (today) — `.git/` present, `git log -1` answers "what's actually deployed"
2. **`git archive | ssh tar -x`** — snapshot only, lighter, but loses on-host debugging

Option 1 wins: git is small, on-host commit visibility is genuinely useful when debugging staging.

## Why Prod Loses Node/Stack/Git

Prod flow (`flow.md`):

1. SSH receives `compose up -d`
2. Docker pulls image from ECR
3. Container starts

No source, no build, no merge step (in target state). Migration path:

- Move `generate-all.ts` config merging to dev — produce final `docker-compose.yml` locally, scp it
- Replace any prod-side stack scanfixes with dev-side scanfixes that SSH and inspect

## Rules

- **Never expand prod's installed surface.** New scanfixes targeting prod must run from dev via SSH, not server-side.
- **Staging may grow** (it's already the build host) — but only when the alternative is materially worse on dev.
- **Every remote scanfix needs a sync-verification scanfix** so version drift is a blocker, not a silent bug.
- **`stack.local.yml` gates dev-machine behavior** (`dev_only`, `claude_skills`). Server stages never read it.
