# Quick Start Guide - Centralized Infrastructure Deployment

**TL;DR:** All configuration lives in the infrastructure repo. One-button deploy sets up everything automatically.

## Architecture Overview

**Single Source of Truth:** Infrastructure repo holds ALL configuration:
- Server mappings (which repos on which servers) in `infrastructure-config.yml`
- SSH keys for all servers (GitHub Secrets)
- Environment variables for all repos/environments (GitHub Secrets/Variables)
- Domain configurations

**Deployment Flow:**
1. Repo pushes to `main` or `production` branch
2. Repo workflow triggers infrastructure repo via `repository_dispatch` webhook
3. Infrastructure repo reads `infrastructure-config.yml`
4. Infrastructure repo identifies which server(s) need deployment
5. Infrastructure repo SSHs to appropriate server(s) and deploys

## Initial Setup

### 1. Configure Infrastructure Repo

**Step 1: Create `infrastructure-config.yml`**

Create or update `infrastructure-config.yml` in the infrastructure repo root:

```yaml
servers:
  mac_mini:
    ssh_key_secret: MAC_MINI_SSH
    host: mac-mini.local  # Update with actual hostname/IP
    user: jon  # Update with actual username
    repos:
      - name: factiii
        environment: staging
        domain_override: null  # Uses default: staging-factiii.greasemoto.com
      - name: chop-shop
        environment: staging
        domain_override: api.greasemoto.com  # Special case
        
  ec2:
    ssh_key_secret: EC2_SSH
    host: ec2-xxx.amazonaws.com  # Update with actual EC2 hostname/IP
    user: ec2-user  # Update with actual username
    repos:
      - name: factiii
        environment: prod
      - name: chop-shop
        environment: prod
        domain_override: api.greasemoto.com

# Global configuration
base_domain: greasemoto.com
ssl_email: admin@greasemoto.com
```

**Step 2: Configure GitHub Secrets**

Go to **Settings → Secrets and variables → Actions** in the infrastructure repo.

**SSH Keys (one per server, stored as secrets):**
- `MAC_MINI_SSH` - SSH private key for Mac Mini
- `EC2_SSH` - SSH private key for EC2
- `SERVER2_SSH` - SSH private key for any additional servers

**Environment Variables (per repo/environment, stored as secrets/variables):**
- `FACTIII_STAGING_ENVS` - Staging env vars for factiii (can be variables if not sensitive)
- `FACTIII_PROD_ENVS` - Production env vars for factiii (MUST be secret)
- `CHOPSHOP_STAGING_ENVS` - Staging env vars for chop-shop
- `CHOPSHOP_PROD_ENVS` - Production env vars for chop-shop

**Format for ENVS:** 
- Newline-separated `key=value` pairs (one per line)
- Example:
  ```
  NODE_ENV=staging
  PORT=5001
  DATABASE_URL=postgresql://postgres:postgres@postgres-staging:5432/factiii_staging
  ```

**Optional: Store config in GitHub Environment Variable**

You can also store the entire `infrastructure-config.yml` content in a GitHub Environment variable:
- Go to **Settings → Environments → staging** (or production)
- Add variable: `INFRASTRUCTURE_CONFIG` with the full YAML content
- The setup workflow can read from this instead of the file

### 2. Setup Each Server

On each target server (Mac Mini, EC2, etc.):

```bash
# Clone infrastructure repo
git clone <infrastructure-repo-url> infrastructure
cd infrastructure

# Set environment (optional, for backward compatibility)
echo "INFRA_ENV=staging" > infra.conf  # or "prod" for EC2

# Install dependencies (if needed)
# - Docker
# - Docker Compose
# - Git
```

### 3. Run Initial Setup

**Option A: Using GitHub Actions Workflow (Recommended)**

1. Go to **Actions → "Setup Infrastructure"**
2. Click **"Run workflow"**
3. Select:
   - **Config source:** `file` (or `github-env` if stored in environment variable)
   - **Environment:** `staging` or `production`
4. Click **"Run workflow"**

The workflow will:
- Read `infrastructure-config.yml`
- For each server in config:
  - SSHs to server
  - Sets up Docker, Nginx, SSL
  - Clones all configured repos
  - Writes env files from GitHub Secrets
  - Deploys all repos

**Option B: Manual Setup**

```bash
# On each server
cd infrastructure
./scripts/setup-infrastructure.sh <server-name>
```

## Individual Repo Setup

### Add Repository Trigger Workflow

Each application repo needs a simple workflow to trigger infrastructure deployment.

Create `.github/workflows/trigger-infrastructure.yml` in each app repo:

```yaml
name: Trigger Infrastructure Deploy

on:
  push:
    branches: [main, production]

jobs:
  trigger-infrastructure:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Infrastructure Deployment
        uses: peter-evans/repository-dispatch@v2
        with:
          token: ${{ secrets.INFRASTRUCTURE_DISPATCH_TOKEN }}
          repository: owner/infrastructure  # Update with your infrastructure repo
          event-type: repo-updated
          client-payload: |
            {
              "repo_name": "${{ github.event.repository.name }}",
              "branch": "${{ github.ref_name }}",
              "environment": "${{ github.ref_name == 'production' && 'prod' || 'staging' }}",
              "commit_sha": "${{ github.sha }}"
            }
```

**Required Secret in App Repo:**
- `INFRASTRUCTURE_DISPATCH_TOKEN` - Personal Access Token with `repo` scope, created in infrastructure repo settings

## Deployment Workflows

### Manual Deploy All

1. Go to **Actions → "Deploy Infrastructure"**
2. Click **"Run workflow"**
3. Select:
   - **Deploy scope:** `all`
   - **Environment:** `both` (or specific)
4. Click **"Run workflow"**

### Deploy Specific Repo

1. Go to **Actions → "Deploy Infrastructure"**
2. Click **"Run workflow"**
3. Select:
   - **Deploy scope:** `specific-repo`
   - **Repo name:** e.g., `factiii`
   - **Environment:** `staging`, `prod`, or `both`
4. Click **"Run workflow"**

### Auto Deploy on Repo Push

When a repo pushes to `main` or `production`:
1. Repo workflow triggers infrastructure via webhook
2. Infrastructure receives webhook, reads config
3. Finds all servers that have this repo for matching environment
4. For each server:
   - SSHs to server
   - Pulls latest infrastructure repo
   - Pulls latest target repo
   - Writes env file from GitHub Secrets (`<REPO>_<ENV>_ENVS`)
   - Runs `docker-compose up -d <repo>-<env>` to recreate container

### Add New Repo

1. Go to **Actions → "Add Repo to Infrastructure"**
2. Click **"Run workflow"**
3. Enter:
   - **Repository name:** e.g., `my-new-repo`
   - **Git URL:** e.g., `https://github.com/user/my-new-repo.git`
   - **Server name:** e.g., `mac_mini`
   - **Environment:** `staging` or `prod`
   - **Domain override:** (optional, leave empty for default)
4. Click **"Run workflow"**

Workflow will:
- Add repo to `infrastructure-config.yml`
- Commit changes
- Setup repo on target server
- Deploy the new repo

### Remove Repo

1. Go to **Actions → "Remove Repo from Infrastructure"**
2. Click **"Run workflow"**
3. Enter:
   - **Repository name:** e.g., `my-old-repo`
   - **Server name:** e.g., `mac_mini`
   - **Environment:** `staging` or `prod`
4. Click **"Run workflow"**

## Configuration Reference

### infrastructure-config.yml Structure

```yaml
servers:
  <server-name>:
    ssh_key_secret: <SECRET_NAME>  # GitHub Secret name for SSH key
    host: <hostname-or-ip>
    user: <ssh-username>
    repos:
      - name: <repo-name>
        environment: staging | prod
        domain_override: <domain> | null  # Optional override

base_domain: <domain>
ssl_email: <email>
```

### GitHub Secrets Structure

**SSH Keys:**
- Format: SSH private key content
- Naming: `<SERVER_NAME>_SSH` (e.g., `MAC_MINI_SSH`)

**Environment Variables:**
- Format: Newline-separated `key=value` pairs
- Naming: `<REPO_NAME>_<ENV>_ENVS` (e.g., `FACTIII_STAGING_ENVS`)
- Staging: Can be variables (non-secret) if not sensitive
- Production: MUST be secrets

## Troubleshooting

### "SSH connection failed"
- Verify SSH key is in GitHub Secrets with correct name
- Test SSH manually: `ssh -i ~/.ssh/key user@host`
- Check hostname/IP is correct in `infrastructure-config.yml`
- Ensure firewall allows SSH (port 22)

### "Config file not found"
- Ensure `infrastructure-config.yml` exists in repo root
- Or set `INFRASTRUCTURE_CONFIG` in GitHub Environment variables

### "Repo not found on server"
- Run initial setup workflow first
- Or manually clone repo: `./scripts/setup-repo.sh <repo-name> <git-url>`

### "Environment variables missing"
- Verify GitHub Secret exists: `<REPO>_<ENV>_ENVS`
- Check secret format is `key=value` (one per line)
- Ensure secret is accessible in the workflow environment

### "Docker compose failed"
- Check logs: `docker-compose logs <service-name>`
- Verify env file exists: `ls secrets/<repo-name>-<env>.env`
- Run validation: `./scripts/validate-infra.sh`

## Next Steps

- See **[INITIAL_SETUP.md](INITIAL_SETUP.md)** for detailed server setup
- See **[REPO_SETUP.md](REPO_SETUP.md)** for adding new repositories
- See **[README.md](README.md)** for full documentation
