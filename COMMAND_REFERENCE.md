# Factiii Stack Command Reference

Quick reference for the three main commands and how they handle local vs remote stages.

## Command Behavior Matrix

| Command | Dev/Secrets | Staging/Prod | Workflow Triggered |
|---------|-------------|--------------|-------------------|
| `npx factiii scan` | Runs locally | Triggers workflow | `factiii-scan-{stage}.yml` |
| `npx factiii fix` | Runs locally | Triggers workflow | `factiii-fix-{stage}.yml` |
| `npx factiii deploy` | Runs locally | Triggers workflow | `factiii-deploy.yml` |

## Scan Command

**Purpose:** Check for issues without making changes.

```bash
# Scan all stages
npx factiii scan

# Scan specific stage
npx factiii scan --dev
npx factiii scan --staging
npx factiii scan --prod

# On server (called by workflow)
npx factiii scan --on-server --staging
```

**Output:**
- Shows pipeline status for each stage
- Lists issues found (auto-fixable vs manual)
- Triggers remote workflows for staging/prod

## Fix Command

**Purpose:** Automatically fix detected issues.

```bash
# Fix all stages
npx factiii fix

# Fix specific stage
npx factiii fix --dev
npx factiii fix --staging
npx factiii fix --prod

# On server (called by workflow)
npx factiii fix --on-server --staging
```

**What it does:**
- Runs auto-fixes for fixable issues
- Reports manual fixes required
- Triggers remote workflows for staging/prod
- Shows summary: Fixed, Manual, Failed counts

## Deploy Command

**Purpose:** Deploy application to target environment.

```bash
# Deploy to specific environment
npx factiii deploy --staging
npx factiii deploy --prod

# On server (called by workflow)
npx factiii deploy --on-server --staging
```

**What it does:**
- Runs pre-deploy checks (scan)
- Attempts to auto-fix critical issues
- Deploys application
- Triggers remote workflows for staging/prod

## Workflow Files Generated

Running `npx factiii generate-workflows` creates:

```
.github/workflows/
├── factiii-deploy.yml          # Manual deployment
├── factiii-staging.yml         # Auto-deploy on push to main
├── factiii-production.yml      # Auto-deploy on merge to production
├── factiii-undeploy.yml        # Manual cleanup
├── factiii-scan-staging.yml    # Scan staging server
├── factiii-scan-prod.yml       # Scan production server
├── factiii-fix-staging.yml     # Fix staging server
├── factiii-fix-prod.yml        # Fix production server
└── factiii-dev-sync.yml        # Dev sync for testing
```

## The --on-server Flag

**Critical:** Workflows MUST use `--on-server` when running commands on remote servers.

**Why?**
- Prevents recursive SSH attempts
- Bypasses reachability checks (we're already on the server)
- Ensures correct environment context

**Example workflow command:**
```bash
ssh user@host "npx factiii fix --on-server --staging"
```

**Without --on-server:**
- Command tries to SSH again → connection loop
- Fails with "Connection refused" or infinite loops

## Reachability

The pipeline plugin's `canReach()` method determines how to reach each stage:

| Stage | Via | Behavior |
|-------|-----|----------|
| `dev` | `local` | Run directly on dev machine |
| `secrets` | `github-api` | Use GitHub API with GITHUB_TOKEN |
| `staging` | `workflow` | Trigger GitHub Actions workflow |
| `prod` | `workflow` | Trigger GitHub Actions workflow |

**When on server:**
- `--on-server` flag bypasses `canReach()` checks
- All stages run as `via: 'local'`

## Common Workflows

### Check staging for issues
```bash
npx factiii scan --staging
```
Triggers workflow → SSHs to staging → runs scan → reports results

### Fix staging issues
```bash
npx factiii fix --staging
```
Triggers workflow → SSHs to staging → runs fixes → reports results

### Deploy to staging
```bash
npx factiii deploy --staging
```
Triggers workflow → SSHs to staging → runs deployment

### Check all stages
```bash
npx factiii scan
```
- Scans dev/secrets locally
- Triggers workflows for staging/prod

### Fix all stages
```bash
npx factiii fix
```
- Fixes dev/secrets locally
- Triggers workflows for staging/prod

## GitHub Secrets Required

For remote operations, these secrets must be configured:

| Secret | Purpose | Used By |
|--------|---------|---------|
| `STAGING_SSH` | SSH private key for staging | scan/fix/deploy staging |
| `PROD_SSH` | SSH private key for production | scan/fix/deploy prod |
| `AWS_SECRET_ACCESS_KEY` | AWS credentials | ECR push/pull |

**Configure at:**
`https://github.com/USER/REPO/settings/secrets/actions`

## Troubleshooting

### "HTTP 422: Unexpected inputs provided"
- **Cause:** Workflow doesn't accept inputs
- **Fix:** Updated in v2.0.1+ (scan/fix workflows don't need inputs)

### "workflow not found on the default branch"
- **Cause:** Workflow file not committed to repository
- **Fix:** Commit and push `.github/workflows/*.yml` files

### "No SSH key found"
- **Cause:** GitHub Secret not configured
- **Fix:** Add `STAGING_SSH` or `PROD_SSH` secret

### "Connection refused" when running on server
- **Cause:** Missing `--on-server` flag
- **Fix:** Workflows must use `--on-server` flag

## Architecture Notes

### Ultra-Thin Workflows

Workflows should ONLY:
1. Read configuration from `factiii.yml`
2. Setup SSH keys from GitHub Secrets
3. Bootstrap Node.js (one-time prerequisite)
4. SSH to server and run CLI command

All business logic lives in plugins, not workflows.

### Stage-Specific Execution

When workflows run on servers, they use stage-specific flags:
- `--on-server --staging` → Only operates on staging
- `--on-server --prod` → Only operates on prod

This prevents:
- Dev checks running on staging server
- Staging operations affecting prod
- Cross-environment contamination

### Plugin Responsibilities

Each plugin category handles specific checks:
- **Pipeline:** Node.js availability, GitHub CLI
- **Server:** Docker, git, pnpm installation
- **Framework:** Dependencies, configs, migrations
- **Secrets:** GitHub Secrets, AWS credentials

All checks merge together in the scan phase.

