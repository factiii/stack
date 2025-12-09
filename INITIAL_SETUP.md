# Initial Infrastructure Setup

Quick setup guide for getting infrastructure running.

> **NEW: Centralized Deployment**
> For the recommended one-button deploy approach, see **[QUICK_START.md](QUICK_START.md)**.
> This document covers manual server setup. The centralized approach automates most of these steps.

## Choose Your Setup Method

### Option A: Centralized Deployment (Recommended)

Use GitHub Actions workflows to deploy everything automatically:
1. Configure `infrastructure-config.yml` with your servers and repos
2. Add SSH keys and environment variables to GitHub Secrets
3. Run the "Setup Infrastructure" workflow

See **[QUICK_START.md](QUICK_START.md)** for complete instructions.

### Option B: Manual Setup (This Document)

Follow the steps below to manually set up each server.

---

## Manual Setup Steps

### 1. Clone Infrastructure Repo

```bash
git clone <infrastructure-repo-url> infrastructure
cd infrastructure
```

### 2. Clone Application Repos

```bash
./scripts/setup-repo.sh factiii <git-url>
./scripts/setup-repo.sh chop-shop <git-url>
# ... repeat for each repo
```

This clones repos to `repos/` and creates env file templates in `secrets/`.

### 3. Configure Environment Files

Edit env files in `secrets/` directory:

```bash
# Staging (uses local postgres-staging)
secrets/factiii-staging.env
secrets/chop-shop-staging.env
# ...

# Production (uses RDS)
secrets/factiii-prod.env
secrets/chop-shop-prod.env
# ...
```

**Key settings:**
- `DATABASE_URL`: For staging use `postgresql://postgres:postgres@postgres-staging:5432/<db-name>`
- `PORT`: Match the port in docker-compose.yml healthcheck
- `CLIENT_APP_URL`: Staging domain for staging, prod domain for prod

### 4. Verify Docker Compose

```bash
# Check configuration
docker-compose config

# Start services
docker-compose up -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f
```

### 5. Verify Nginx

```bash
# Test nginx config
docker-compose exec nginx nginx -t

# Reload if needed
docker-compose exec nginx nginx -s reload
```

### 6. Setup SSL Certificates

```bash
# Initial certificate generation
docker-compose up certbot

# Renewal (add to crontab)
docker-compose run --rm certbot renew
```

### 7. Setup GitHub Self-Hosted Runner (Optional)

> **Note:** Self-hosted runners are optional with the centralized approach.
> The GitHub Actions workflows can deploy via SSH without a local runner.

If you want a self-hosted runner:

1. Go to GitHub repo → Settings → Actions → Runners
2. Click "New self-hosted runner"
3. Choose macOS and your architecture (arm64 for Apple Silicon, x64 for Intel)
4. **Copy the registration token** shown on the GitHub page
5. Run commands in the infrastructure directory:

```bash
cd /path/to/infrastructure/actions-runner
curl -o actions-runner-osx-arm64-2.329.0.tar.gz -L https://github.com/actions/runner/releases/download/v2.329.0/actions-runner-osx-arm64-2.329.0.tar.gz
tar xzf ./actions-runner-osx-arm64-2.329.0.tar.gz
./config.sh --url https://github.com/YOUR-USERNAME/YOUR-REPO --token YOUR-TOKEN
```

**After configuration completes:**
```bash
./svc.sh install
./svc.sh start
```

## 8. Configure GitHub Secrets (Centralized Approach)

> **Important:** With the centralized approach, ALL secrets are stored in the **infrastructure repo only**.
> Individual repos only need an `INFRASTRUCTURE_DISPATCH_TOKEN` to trigger deployments.

### Infrastructure Repo Secrets

Go to **infrastructure repo → Settings → Secrets and variables → Actions**

**SSH Keys (one per server):**
- `MAC_MINI_SSH` - SSH private key for Mac Mini
- `EC2_SSH` - SSH private key for EC2

**Environment Variables (per repo/environment):**
- `FACTIII_STAGING_ENVS` - All env vars for factiii staging (newline-separated `key=value`)
- `FACTIII_PROD_ENVS` - All env vars for factiii production (MUST be secret)
- `CHOPSHOP_STAGING_ENVS` - All env vars for chop-shop staging
- `CHOPSHOP_PROD_ENVS` - All env vars for chop-shop production
- ... repeat for each repo

**Format for ENVS secrets:**
```
NODE_ENV=staging
PORT=5001
DATABASE_URL=postgresql://postgres:postgres@postgres-staging:5432/factiii_staging
CLIENT_APP_URL=https://staging-factiii.greasemoto.com
```

### Individual Repo Secrets (Minimal)

Each application repo only needs:
- `INFRASTRUCTURE_DISPATCH_TOKEN` - Personal Access Token with `repo` scope to trigger infrastructure workflows

**To create the token:**
1. Go to GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Generate new token with `repo` scope
3. Copy token and add as `INFRASTRUCTURE_DISPATCH_TOKEN` secret in each app repo

## 9. Create Trigger Workflows in App Repos

Each app repo needs a simple workflow to trigger infrastructure deployment.

Create `.github/workflows/trigger-infrastructure.yml`:

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
          repository: YOUR-ORG/infrastructure  # Update with your infrastructure repo
          event-type: repo-updated
          client-payload: |
            {
              "repo_name": "${{ github.event.repository.name }}",
              "branch": "${{ github.ref_name }}",
              "environment": "${{ github.ref_name == 'production' && 'prod' || 'staging' }}",
              "commit_sha": "${{ github.sha }}"
            }
```

## 10. Test Deployment

**Using GitHub Actions (Recommended):**
1. Go to infrastructure repo → Actions → "Deploy Infrastructure"
2. Click "Run workflow"
3. Select deployment scope and environment
4. Click "Run workflow"

**Manual Staging Test:**
```bash
./scripts/deploy.sh factiii staging
```

**Auto-Deploy:**
- Push to `main` branch → triggers staging deployment
- Push to `production` branch → triggers production deployment

## Troubleshooting

- **Services won't start**: Check `docker-compose logs <service-name>`
- **Nginx routing issues**: Test config with `docker-compose exec nginx nginx -t`
- **Database connection**: Verify `DATABASE_URL` in env files
- **Runner not picking up jobs**: Check runner status with `./svc.sh status`
- **SSH connection failed**: Verify SSH key is in GitHub Secrets and server is accessible

## Next Steps

- See **[QUICK_START.md](QUICK_START.md)** for centralized deployment guide
- See **[REPO_SETUP.md](REPO_SETUP.md)** for adding new repos
- See **[README.md](README.md)** for detailed documentation
