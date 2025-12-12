# Infrastructure Package

An npm package for managing infrastructure deployments across multiple repositories. Each repo manages its own configuration, and servers automatically discover and merge configs to generate unified docker-compose and nginx configurations.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    INDIVIDUAL REPOS                         │
│  (factiii, chop-shop, link3d, tap-track)                    │
├─────────────────────────────────────────────────────────────┤
│  core.yml (per repo)                                        │
│  GitHub Secrets: SSH_STAGING, SSH_PROD, AWS_SECRETS         │
│  Workflows: CheckConfig, DeployStaging, DeployProd          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      SERVERS                                │
│  (staging, production)                                      │
├─────────────────────────────────────────────────────────────┤
│  ~/infrastructure/                                          │
│    ├── configs/          # One config per repo              │
│    │   ├── factiii.yml                                      │
│    │   ├── chop-shop.yml                                    │
│    │   └── ...                                              │
│    ├── docker-compose.yml    # Generated from all configs   │
│    ├── nginx/nginx.conf      # Generated from all configs  │
│    └── scripts/              # From package                 │
└─────────────────────────────────────────────────────────────┘
```

## Installation

### As an npm Package (Recommended)

```bash
npm install @factiii/core
```

### Local Development

```bash
git clone <infrastructure-repo-url>
cd infrastructure
npm install
npm link  # For local development
```

## Quick Start

### 1. Initialize Your Repo

In your repository root:

```bash
npx core init
```

This creates a `core.yml` file. Edit it with your domains and settings:

```yaml
name: your-repo-name
environments:
  staging:
    domain: staging-your-repo.yourdomain.com
    health_check: /health
  prod:
    domain: your-repo.yourdomain.com
    health_check: /health

ssl_email: admin@yourdomain.com
ecr_registry: 123456789.dkr.ecr.us-east-1.amazonaws.com
ecr_repository: apps
```

### 2. Validate Configuration

```bash
npx core validate
```

### 3. Generate GitHub Workflows

```bash
npx core generate-workflows
```

This creates:
- `.github/workflows/init.yml` - Deployment readiness checker (validates config, secrets, server state)
- `.github/workflows/deploy.yml` - Deploys to staging and production (runs init checks first)
- `.github/workflows/undeploy.yml` - Completely removes repo from staging and prod servers

### 4. Add GitHub Secrets

#### Environment Variables via .env Files (Recommended)

The modern approach uses `.env` files that are automatically synced to GitHub:

1. **Create `.env.example`** (template, committed to git):
   ```bash
   # .env.example - Defines all required keys
   NODE_ENV=development
   DATABASE_URL=postgresql://EXAMPLE-user:EXAMPLE-pass@localhost:5432/EXAMPLE-myapp
   JWT_SECRET=EXAMPLE-your-secret-key
   ```

2. **Create `.env.staging`** (actual staging values):
   ```bash
   # .env.staging - Real staging values
   NODE_ENV=staging
   DATABASE_URL=postgresql://user:pass@postgres-staging:5432/myapp
   JWT_SECRET=actual-staging-secret-123
   ```

3. **Create `.env.prod`** (actual production values):
   ```bash
   # .env.prod - Real production values (MUST be gitignored)
   NODE_ENV=production
   DATABASE_URL=postgresql://user:pass@postgres-prod:5432/myapp
   JWT_SECRET=actual-production-secret-456
   ```

4. **Add to `.gitignore`**:
   ```
   .env.prod           # Always gitignore prod
   # .env.staging      # Optional, based on core.yml auto.isStagingSecret
   ```

5. **Run `npx core init`** to validate and sync to GitHub

**Benefits:**
- ✅ `.env.example` acts as template showing required keys
- ✅ All environments have matching keys (validated)
- ✅ Auto-synced to GitHub Secrets/Variables
- ✅ Staging can be public (Variables) or secret based on `core.yml`
- ✅ Production always secret

#### GitHub Secrets (Manual Method)

Alternatively, add secrets directly in your repository's **Settings → Secrets → Actions**:

- `STAGING_SSH` - SSH private key for staging server
- `PROD_SSH` - SSH private key for production server
- `STAGING_HOST` - Staging server hostname/IP
- `STAGING_USER` - SSH user for staging (default: ubuntu)
- `PROD_HOST` - Production server hostname/IP
- `PROD_USER` - SSH user for production (default: ubuntu)
- `AWS_ACCESS_KEY_ID` - AWS access key ID for ECR
- `AWS_SECRET_ACCESS_KEY` - AWS secret access key for ECR
- `AWS_REGION` - AWS region (e.g., us-east-1)
- `STAGING_ENVS` - Environment variables (newline-separated `key=value` pairs)
- `PROD_ENVS` - Environment variables (newline-separated `key=value` pairs)

**Note:** ECR registry and repository are read from your `core.yml` config file, not from secrets.

### 5. Verify Deployment Readiness (Optional but Recommended)

Before deploying, run the Init workflow to verify everything is configured correctly:

1. Go to your repository's **Actions** tab in GitHub
2. Select **"Init Check"** workflow
3. Click **"Run workflow"**
4. Review the comprehensive deployment readiness report

This will verify:
- All GitHub secrets are configured
- SSH connectivity to servers works
- Show what's currently deployed and what will change

### 6. Deploy

Push to `main` branch to trigger staging deployment, or manually run the workflows from the Actions tab.

The deploy workflow will automatically run the same init checks before deploying.

## CLI Commands

### `core init`

Initialize `core.yml` config file and perform local validation checks.

```bash
npx core init
npx core init --force  # Overwrite existing
```

**What it does (Local Checks Only):**
- Creates `core.yml` if missing (from template)
- Validates `core.yml` has no placeholder values
- Checks Dockerfile exists
- Validates git configuration
- Checks GitHub workflows exist (deploy.yml, undeploy.yml, init.yml)
- Validates required package.json scripts
- Checks Prisma configuration (if applicable)
- Generates missing workflows

**Output:** Local validation report + instructions to run Init workflow in GitHub Actions

**For full deployment readiness check (including GitHub secrets and server state), run the Init workflow in GitHub Actions** (see below)

### `core validate`

Validate your `infrastructure.yml` file.

```bash
npx core validate
npx core validate --config path/to/core.yml
```

### `core check-config`

Check and regenerate configurations on servers.

```bash
# Check all environments
npx core check-config

# Check specific environment
npx core check-config --environment staging

# With explicit credentials
npx core check-config \
  --ssh-staging "$SSH_KEY" \
  --staging-host "192.168.1.100" \
  --staging-user "admin"
```

### `core generate-workflows`

Generate GitHub workflow files.

```bash
npx core generate-workflows
npx core generate-workflows --output .github/workflows
```

## Configuration Format

Each repo's `infrastructure.yml`:

```yaml
# Repository name (must match GitHub repo name)
name: factiii

# Environment configurations
environments:
  staging:
    # Domain for staging
    domain: staging-factiii.yourdomain.com
    
    # Port (optional - auto-assigned if not specified)
    port: 3001
    
    # Health check endpoint
    health_check: /health
    
    # Dependencies (optional)
    depends_on: [postgres-staging]
    
    # Environment file path (optional)
    env_file: .env.staging

  prod:
    domain: factiii.yourdomain.com
    port: 3002
    health_check: /health

# Global settings
ssl_email: admin@yourdomain.com

# ECR configuration (used for building and pushing Docker images)
ecr_registry: 123456789.dkr.ecr.us-east-1.amazonaws.com
ecr_repository: apps

# Dockerfile path (optional, defaults to Dockerfile)
# dockerfile: Dockerfile
# dockerfile: apps/server/Dockerfile  # Example for monorepo

# Auto-detected/configured settings (always at bottom)
auto:
  # Whether staging env should be treated as secret
  # true = GitHub Secret, false = GitHub Variable
  isStagingSecret: true
  
  # Auto-detected Prisma configuration (if present)
  # prisma_schema: apps/server/prisma/schema.prisma
  # prisma_version: 5.7.0
```

### Auto Section

The `auto:` section (always at the bottom of `core.yml`) contains auto-detected or default configuration:

- **`isStagingSecret`**: Controls whether `.env.staging` is stored as GitHub Secret (true) or Variable (false)
  - Default: `true` (keep staging secrets private)
  - Set to `false` if staging environment variables can be public
  
- **Prisma settings**: Auto-detected from your project structure
  - `prisma_schema`: Path to schema.prisma file
  - `prisma_version`: Version from package.json

**Override Pattern**: To customize auto settings, uncomment and modify:

```yaml
auto:
  isStagingSecret: false  # Make staging variables public
  # prisma_schema: OVERRIDE custom/path/schema.prisma
```

## Server Setup

### Initial Server Setup

On each server (staging and production):

```bash
# Create infrastructure directory
mkdir -p ~/infrastructure/{configs,scripts,nginx}

# Install Node.js (if not already installed)
# Install Docker and docker-compose
```

**Note:** Secrets are stored securely in root-level files (e.g., `~/infrastructure/<repo-name>-<env>.env`), not in a `secrets/` folder. The `check-config` command handles this automatically.

### Config Discovery

The `CheckConfig` workflow (or manual `core check-config`) will:

1. SSH to the server
2. Scan `~/infrastructure/configs/*.yml` for all repo configs
3. Merge configs and assign ports (auto-increment from 3001)
4. Generate unified `docker-compose.yml` and `nginx/nginx.conf`
5. Validate and reload nginx

### Port Assignment

- Ports auto-assign starting at 3001
- If a repo specifies a port, it's used (if available)
- Conflicts are detected and reassigned automatically
- Port assignments are stored in generated docker-compose

## Deployment Flow

1. **Repo pushes code** → Triggers `DeployStaging` or `DeployProd` workflow
2. **Workflow builds** Docker image using AWS CLI:
   - Reads ECR registry from `core.yml`
   - Uses `aws ecr get-login-password` for authentication
   - Builds with `--platform linux/amd64` flag
   - Pushes image with `:latest` tag
3. **Workflow SSHs** to target server
4. **Updates config** in `~/infrastructure/configs/<repo-name>.yml`
5. **Runs deploy.yml workflow** which regenerates nginx/docker-compose from all configs
6. **Runs** `docker compose pull <service>` and `docker compose up -d <service>`

## Workflows

### Init (Deployment Readiness Check)

**File:** `.github/workflows/init.yml`

**Trigger:** Manual (workflow_dispatch from GitHub Actions tab)

Comprehensive deployment readiness checker that verifies your application is ready to deploy:

**What it checks:**
1. **Local Configuration**
   - Validates `core.yml`, Dockerfile, workflows, git setup
   
2. **GitHub Secrets**
   - Uses built-in `GITHUB_TOKEN` to verify all required secrets exist
   - Lists missing secrets that need to be added
   - Required secrets: SSH keys, hosts, AWS credentials, environment variables

3. **Server State (Staging & Production)**
   - Tests SSH connectivity to servers
   - Discovers ALL currently deployed repos on each server
   - Compares your local `core.yml` with deployed version (if exists)
   - Shows what will change when you deploy
   - Checks Docker container and nginx status

**Output:** Comprehensive report showing:
- Current deployment state on each server
- All other repos deployed on same servers
- What will change after deploy
- Missing secrets or configuration issues

**How to run:**
1. Go to GitHub Actions tab
2. Select "Init Check" workflow
3. Click "Run workflow"
4. Review the deployment readiness report

**Example output:**
```
🚀 DEPLOYMENT READINESS REPORT - myapp

📡 STAGING SERVER
   📦 Currently Deployed: factiii, chop-shop, link3d
   📋 THIS REPO: staging-myapp.domain.com:3004
   🔄 Changes: domain updated

🌐 PRODUCTION SERVER
   📦 Currently Deployed: factiii, chop-shop, link3d
   📋 THIS REPO: NOT DEPLOYED (will be new deployment)

✅ READY TO DEPLOY (check full report for details)
```

### Deploy

**Trigger:** Push to `main`/`develop`, manual (workflow_dispatch), or daily schedule (2 AM UTC)

Deploys your application to staging or production servers. **Runs the same checks as Init workflow first**, then proceeds with deployment.

**Deploy is idempotent** - can be run multiple times safely. Each run will update configs and restart services.

**For staging:**
1. Runs all init checks (validates config, secrets, server state)
2. Builds and tests code
3. Builds Docker image
4. Pushes to ECR
5. SSHs to staging server
6. Copies `core.yml` to `~/infrastructure/configs/{repo-name}.yml`
7. Copies environment variables to `~/infrastructure/{repo-name}-staging.env`
8. Regenerates `docker-compose.yml` and `nginx.conf` from ALL configs on server
9. Pulls latest image and restarts ALL services

**For prod:**
1. Runs all init checks (validates config, secrets, server state)
2. SSHs to prod server (no building - containers already built in staging)
3. Copies `core.yml` to `~/infrastructure/configs/{repo-name}.yml`
4. Copies environment variables to `~/infrastructure/{repo-name}-prod.env`
5. Regenerates `docker-compose.yml` and `nginx.conf` from ALL configs on server
6. Pulls latest image and restarts ALL services

**⚠️ Important:** Deploy regenerates infrastructure configs and **restarts ALL services** on the server, not just yours. This ensures nginx and docker-compose are always in sync with all deployed repos.

### Undeploy

**Trigger:** Manual (workflow_dispatch)

Completely removes this repository from staging and production servers:
- Deletes all configs, environment files, containers, and data
- Regenerates infrastructure configs without the removed repo
- **This action cannot be undone**

## Adding a New Service

1. In your repo, run `npx core init`
2. Edit `core.yml` with your domains and ECR settings
3. Create environment files:
   - `.env.example` (template with all keys, committed)
   - `.env.staging` (actual staging values)
   - `.env.prod` (actual production values, gitignored)
4. Run `npx core init` to:
   - Validate all configurations
   - Generate workflows (init.yml, deploy.yml, undeploy.yml)
   - Sync .env files to GitHub Secrets/Variables
5. Add remaining GitHub secrets in Settings → Secrets → Actions:
   - `STAGING_SSH`, `PROD_SSH`, `STAGING_HOST`, `PROD_HOST`
   - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`
   - (STAGING_ENVS, PROD_ENVS auto-synced from .env files)
6. Commit and push workflows to GitHub
7. Push code to trigger deployment, or manually trigger deploy workflow

The service will automatically appear in the server's docker-compose and nginx configs.

## Removing a Service

Use the `remove` command:

```bash
npx core remove --environment staging
npx core remove --environment all
```

Or manually:
1. Remove the config file from `~/infrastructure/configs/<repo-name>.yml` on the server
2. Remove the env file `~/infrastructure/<repo-name>-<env>.env` if it exists
3. Run `core check-config` or trigger `deploy.yml` workflow to regenerate configs
4. The service will be removed from docker-compose and nginx
5. All remaining repos will be verified and reconfigured

## Troubleshooting

### Config not found on server

Ensure your deployment workflow is copying `core.yml` to `~/infrastructure/configs/<repo-name>.yml` on the server.

### Port conflicts

The system auto-assigns ports. If you need a specific port, specify it in your `core.yml`. Conflicts are automatically resolved.

### Nginx not reloading

Check nginx container logs:
```bash
docker logs infrastructure_nginx
docker exec infrastructure_nginx nginx -t
```

### Service not starting

Check service logs:
```bash
docker compose logs <service-name>
docker compose ps
```

## Programmatic Usage

```javascript
const infra = require('@factiii/core');

// Merge configs from a directory
const merged = infra.mergeConfigs('/path/to/configs');

// Generate docker-compose.yml
infra.generateCompose('/path/to/configs', '/path/to/docker-compose.yml');

// Generate nginx.conf
infra.generateNginx('/path/to/configs', '/path/to/nginx.conf');
```

## Legacy Centralized Approach

> **Note:** The centralized `core.yml` approach is still supported for backward compatibility but is not recommended for new setups.

If you're using the legacy centralized approach:

1. Configure `core.yml` with your servers and repos
2. Store it in the repository root (commit it to the repo)
3. Use the `setup-infrastructure.yml` workflow for initial setup
4. Use the `rebuild-service.yml` workflow for deployments

For new repositories, use the decentralized approach described in this README.

## Security Notes

- Never commit SSH keys or AWS credentials
- Use GitHub Secrets for all sensitive values
- Rotate SSH keys and AWS credentials regularly
- Keep Docker images updated
- Monitor logs for suspicious activity

## License

MIT
