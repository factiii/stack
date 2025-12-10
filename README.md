# Infrastructure Package

An npm package for managing infrastructure deployments across multiple repositories. Each repo manages its own configuration, and servers automatically discover and merge configs to generate unified docker-compose and nginx configurations.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    INDIVIDUAL REPOS                         │
│  (factiii, chop-shop, link3d, tap-track)                    │
├─────────────────────────────────────────────────────────────┤
│  infrastructure.yml (per repo)                              │
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
npm install @yourorg/infrastructure
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
npx infra init
```

This creates an `infrastructure.yml` file. Edit it with your domains and settings:

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
npx infra validate
```

### 3. Generate GitHub Workflows

```bash
npx infra generate-workflows
```

This creates:
- `.github/workflows/check-config.yml` - Checks and regenerates configs on servers
- `.github/workflows/deploy-staging.yml` - Deploys to staging
- `.github/workflows/deploy-prod.yml` - Deploys to production

### 4. Add GitHub Secrets

In your repository's **Settings → Secrets → Actions**, add:

- `STAGING_SSH` - SSH private key for staging server
- `PROD_SSH` - SSH private key for production server
- `STAGING_HOST` - Staging server hostname/IP
- `STAGING_USER` - SSH user for staging (default: ubuntu)
- `PROD_HOST` - Production server hostname/IP
- `PROD_USER` - SSH user for production (default: ubuntu)
- `AWS_ACCESS_KEY_ID` - AWS access key ID for ECR
- `AWS_SECRET_ACCESS_KEY` - AWS secret access key for ECR
- `AWS_REGION` - AWS region (e.g., us-east-1)

**Note:** ECR registry and repository are read from your `infrastructure.yml` config file, not from secrets.

### 5. Deploy

Push to `main` branch to trigger staging deployment, or manually run the workflows from the Actions tab.

## CLI Commands

### `infra init`

Initialize `infrastructure.yml` config file.

```bash
npx infra init
npx infra init --force  # Overwrite existing
```

### `infra validate`

Validate your `infrastructure.yml` file.

```bash
npx infra validate
npx infra validate --config path/to/infrastructure.yml
```

### `infra check-config`

Check and regenerate configurations on servers.

```bash
# Check all environments
npx infra check-config

# Check specific environment
npx infra check-config --environment staging

# With explicit credentials
npx infra check-config \
  --ssh-staging "$SSH_KEY" \
  --staging-host "192.168.1.100" \
  --staging-user "admin"
```

### `infra generate-workflows`

Generate GitHub workflow files.

```bash
npx infra generate-workflows
npx infra generate-workflows --output .github/workflows
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

The `CheckConfig` workflow (or manual `infra check-config`) will:

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
   - Reads ECR registry from `infrastructure.yml`
   - Uses `aws ecr get-login-password` for authentication
   - Builds with `--platform linux/amd64` flag
   - Pushes image with `:latest` tag
3. **Workflow SSHs** to target server
4. **Updates config** in `~/infrastructure/configs/<repo-name>.yml`
5. **Runs check-config.sh** to regenerate nginx/docker-compose from all configs
6. **Runs** `docker compose pull <service>` and `docker compose up -d <service>`

## Workflows

### CheckConfig

**Trigger:** Manual or daily schedule (2 AM UTC)

Scans all configs on staging and production servers and regenerates docker-compose and nginx configurations.

### DeployStaging

**Trigger:** Push to `main` or `develop` branch

1. Builds and tests code
2. Builds Docker image
3. Pushes to ECR
4. SSHs to staging server
5. Updates config file
6. Regenerates infrastructure configs
7. Deploys service

### DeployProd

**Trigger:** Push to `main` branch or version tags (`v*`)

Same as DeployStaging but for production.

## Adding a New Service

1. In your repo, run `npx infra init`
2. Edit `infrastructure.yml` with your domains and ECR settings
3. Run `npx infra generate-workflows`
4. Add GitHub secrets (STAGING_SSH, PROD_SSH, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, etc.)
5. Push code to trigger deployment

The service will automatically appear in the server's docker-compose and nginx configs.

## Removing a Service

Use the `remove` command:

```bash
npx infra remove --environment staging
npx infra remove --environment all
```

Or manually:
1. Remove the config file from `~/infrastructure/configs/<repo-name>.yml` on the server
2. Remove the env file `~/infrastructure/<repo-name>-<env>.env` if it exists
3. Run `infra check-config` to regenerate configs
4. The service will be removed from docker-compose and nginx
5. All remaining repos will be verified and reconfigured

## Troubleshooting

### Config not found on server

Ensure your deployment workflow is copying `infrastructure.yml` to `~/infrastructure/configs/<repo-name>.yml` on the server.

### Port conflicts

The system auto-assigns ports. If you need a specific port, specify it in your `infrastructure.yml`. Conflicts are automatically resolved.

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
const infra = require('@yourorg/infrastructure');

// Merge configs from a directory
const merged = infra.mergeConfigs('/path/to/configs');

// Generate docker-compose.yml
infra.generateCompose('/path/to/configs', '/path/to/docker-compose.yml');

// Generate nginx.conf
infra.generateNginx('/path/to/configs', '/path/to/nginx.conf');
```

## Legacy Centralized Approach

> **Note:** The centralized `infrastructure-config.yml` approach is still supported for backward compatibility but is not recommended for new setups.

If you're using the legacy centralized approach:

1. Configure `infrastructure-config.yml` with your servers and repos
2. Store it as a GitHub variable `INFRASTRUCTURE_CONFIG`
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
