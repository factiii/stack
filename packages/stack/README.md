# @factiii/stack

Infrastructure management CLI. Scan, fix, and deploy Node.js apps to AWS with Docker, Nginx, and GitHub Actions.

## Install

```bash
npm install @factiii/stack
```

## Quick Start

```bash
npx stack              # Self-bootstrap + scan
npx stack init         # First-time vault/secrets setup
npx stack scan --dev   # Read-only issue detection
npx stack fix --dev    # Auto-fix detected issues
npx stack deploy --staging  # Scan then deploy
```

## Commands

| Command | Description |
|---------|-------------|
| `npx stack` | Self-bootstrap + scan (default) |
| `npx stack init` | First-time vault/secrets setup |
| `npx stack scan [--stage]` | Read-only issue detection |
| `npx stack fix [--stage]` | Auto-fix detected issues |
| `npx stack deploy --<stage>` | Scan then deploy |
| `npx stack deploy --secrets <action>` | Manage Ansible Vault secrets |
| `npx stack db <cmd> --<stage>` | Database operations (migrate, seed, reset, status) |
| `npx stack ops <cmd> --<stage>` | Server operations (logs, restart, shell, status) |
| `npx stack backup <cmd> --<stage>` | Database backup/restore |
| `npx stack dev-reset [--dry-run]` | Reset local config/secrets for fresh bootstrap |

## Stages

`--dev`, `--secrets`, `--staging`, `--prod`

Routing priority:
1. `dev` / `secrets` → always runs locally
2. `staging` / `prod` → tries SSH key (`~/.ssh/{stage}_deploy_key`) → falls back to GitHub Actions workflow → unreachable

## Config Files

| File | Purpose | Editable By |
|------|---------|-------------|
| `stack.yml` | Manual settings (committed) | User |
| `stackAuto.yml` | Auto-detected settings | Stack CLI |
| `stack.local.yml` | Per-developer overrides (gitignored) | User |

Legacy `factiii.yml` is also supported.

## Plugins

**Pipelines** — CI/CD routing: `factiii`, `aws`

**Servers** — OS-specific commands: `mac`, `ubuntu`, `windows`, `amazon-linux`

**Frameworks** — App scaffolding: `prisma-trpc`, `expo`

**Addons** — Extensions: `server-mode` (hardening), `openclaw` (AI agent), `auth` (@factiii/auth integration)

Plugins auto-detect from your project. No manual registration needed.

## AWS Strategy

Two IAM users per project:
- **Dev account** (dev + staging): `factiii-{project}-dev`
- **Prod account** (prod only): `factiii-{project}-prod`

Provisioning covers EC2, RDS, VPC, ECR, Route 53, and S3.

## Deployment Flow

1. `npx stack` — bootstrap (installs deps, detects frameworks, generates config)
2. `npx stack init` — create vault, store secrets
3. `npx stack fix --staging` — provision infrastructure, push workflows
4. `npx stack deploy --staging` — scan, build, deploy via SSH or GitHub Actions

Workflows are ultra-thin: trigger + secrets + SSH + CLI call. No setup/clone/build logic in CI.

```yaml
ssh -i ~/.ssh/deploy_key "$USER@$HOST" \
  "GITHUB_ACTIONS=true npx stack deploy --staging"
```

## Requirements

- Node.js >= 18.0.0
- pnpm, npm, or yarn

## License

MIT
