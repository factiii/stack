# Quick Start Guide - Infrastructure Package

**TL;DR:** Each repo stores its own `infrastructure.yml` config. Use `npx infra` commands to validate, deploy, update, and remove configurations. The package ensures configs are valid and handles deployment without an external infrastructure layer.

## Architecture Overview

**Decentralized Configuration:** Each repository manages its own infrastructure configuration:
- Each repo has `infrastructure.yml` in its root
- Repos store their own configs (no central infrastructure repo needed)
- Servers collect configs from deployed repos automatically
- Package validates configs and ensures everything works together

**Deployment Flow:**
1. Repo contains `infrastructure.yml` with its deployment config
2. Run `npx infra validate` to check config locally
3. Run `npx infra deploy` (or use GitHub Actions) to deploy config to server
4. Server collects all configs and auto-generates docker-compose.yml and nginx.conf
5. Run `npx infra check-config` to verify everything is working

## Installation

```bash
npm install @yourorg/infrastructure
```

Or use directly with npx (no installation needed):

```bash
npx infra init
```

## Quick Start

### 1. Initialize Your Repo

In your repository root:

```bash
npx infra init
```

This creates an `infrastructure.yml` example file. Edit it with your domains and settings:

```yaml
# Repository name (must match GitHub repo name)
name: your-repo-name

# Environment configurations
environments:
  staging:
    # Domain for staging environment
    domain: staging-your-repo.yourdomain.com
    
    # Port (optional - will be auto-assigned if not specified)
    # port: 3001
    
    # Health check endpoint (defaults to /health)
    health_check: /health
    
    # Dependencies (optional)
    # depends_on: [postgres-staging]
    
    # Environment file path (optional - secrets stored securely on server)
    # env_file: .env.staging

  prod:
    # Domain for production environment
    domain: your-repo.yourdomain.com
    
    # Port (optional - will be auto-assigned if not specified)
    # port: 3002
    
    # Health check endpoint
    health_check: /health
    
    # Dependencies (optional)
    # depends_on: []
    
    # Environment file path (optional)
    # env_file: .env.prod

# Global settings
ssl_email: admin@yourdomain.com

# ECR configuration (used for building and pushing Docker images)
ecr_registry: 123456789.dkr.ecr.us-east-1.amazonaws.com
ecr_repository: apps

# Dockerfile path (optional, defaults to Dockerfile)
# dockerfile: Dockerfile
# dockerfile: apps/server/Dockerfile  # Example for monorepo
```

### 2. Validate Configuration

Check that your config is valid:

```bash
npx infra validate
```

This will:
- ✅ Check required fields are present
- ✅ Validate YAML syntax
- ✅ Check domain formats
- ✅ Verify port ranges
- ✅ Warn about missing optional fields

### 3. Check Configuration on Servers

Before deploying, check if everything is configured correctly on your servers:

```bash
npx infra check-config
```

This command:
- ✅ SSHs to staging and/or production servers
- ✅ Checks all configs on each server
- ✅ Validates GitHub secrets/envs are available
- ✅ Auto-compiles docker-compose.yml and nginx.conf
- ✅ Provides a comprehensive report of:
  - Missing GitHub secrets/envs
  - Config validation issues
  - Port conflicts
  - Domain conflicts
  - Services that need updates
  - Any fixes that were automatically applied

**Options:**
```bash
# Check specific environment
npx infra check-config --environment staging

# Check all environments (default)
npx infra check-config --environment all

# With explicit credentials
npx infra check-config \
  --ssh-staging "$STAGING_SSH_KEY" \
  --staging-host "staging.example.com" \
  --staging-user "ubuntu" \
  --ssh-prod "$PROD_SSH_KEY" \
  --prod-host "prod.example.com" \
  --prod-user "ubuntu"
```

### 4. Deploy Configuration

Deploy or update your config to servers:

```bash
npx infra deploy
```

This command:
- ✅ Validates config locally first
- ✅ SSHs to target server(s)
- ✅ Copies `infrastructure.yml` to server as `configs/<repo-name>.yml`
- ✅ Writes secrets securely to root-level files (named from config)
- ✅ Runs check-config to regenerate docker-compose and nginx
- ✅ Pulls latest Docker image
- ✅ Restarts service

**Options:**
```bash
# Deploy to specific environment
npx infra deploy --environment staging

# Deploy to all environments
npx infra deploy --environment all

# Deploy with explicit credentials
npx infra deploy \
  --environment staging \
  --ssh-staging "$SSH_KEY" \
  --staging-host "staging.example.com"
```

### 5. Remove Configuration

Remove your config from servers:

```bash
npx infra remove
```

This command:
- ✅ Removes config file from server(s)
- ✅ Removes associated secrets/env files
- ✅ Runs check-config to regenerate configs without your repo
- ✅ Ensures all remaining repos on server are still properly configured
- ✅ Verifies no broken dependencies

**Options:**
```bash
# Remove from specific environment
npx infra remove --environment staging

# Remove from all environments
npx infra remove --environment all
```

## GitHub Secrets Setup

In your repository's **Settings → Secrets and variables → Actions**, add:

**SSH Keys:**
- `STAGING_SSH` - SSH private key for staging server
- `PROD_SSH` - SSH private key for production server

**Server Connection:**
- `STAGING_HOST` - Staging server hostname/IP
- `STAGING_USER` - SSH user for staging (default: ubuntu)
- `PROD_HOST` - Production server hostname/IP
- `PROD_USER` - SSH user for production (default: ubuntu)

**AWS Credentials (for ECR):**
- `AWS_ACCESS_KEY_ID` - AWS access key ID
- `AWS_SECRET_ACCESS_KEY` - AWS secret access key
- `AWS_REGION` - AWS region (e.g., us-east-1)

**Environment Variables (optional):**
- `STAGING_ENVS` - Environment variables for staging (newline-separated `key=value` pairs)
- `PROD_ENVS` - Environment variables for production (newline-separated `key=value` pairs)

**Format for ENVS:**
```
NODE_ENV=staging
PORT=5001
DATABASE_URL=postgresql://postgres:postgres@postgres-staging:5432/mydb
```

## Server Setup

On each target server (staging and production):

```bash
# Create infrastructure directory structure
mkdir -p ~/infrastructure/{configs,scripts,nginx}

# Install Node.js (if not already installed)
# Install Docker and docker-compose
```

The `check-config` command will automatically:
- Create necessary directories
- Copy generator scripts
- Generate docker-compose.yml and nginx.conf from all configs
- Validate configurations

## Configuration Reference

### infrastructure.yml Structure

```yaml
name: <repo-name>  # Must match GitHub repo name

environments:
  staging:
    domain: <domain>
    port: <port>  # Optional, auto-assigned if not specified
    health_check: <endpoint>  # Defaults to /health
    depends_on: [<service>]  # Optional
    env_file: <path>  # Optional, secrets stored securely on server

  prod:
    domain: <domain>
    port: <port>
    health_check: <endpoint>
    depends_on: []
    env_file: <path>

ssl_email: <email>
ecr_registry: <ecr-registry-url>
ecr_repository: <ecr-repo-name>
dockerfile: <path>  # Optional, defaults to Dockerfile
```

### How Configs Are Merged

On each server:
1. All `configs/*.yml` files are collected
2. Configs are merged and validated
3. Ports are auto-assigned (starting at 3001) if not specified
4. Domain conflicts are detected
5. Unified `docker-compose.yml` and `nginx/nginx.conf` are generated
6. Secrets are stored securely in root-level files (named from config)

## Troubleshooting

### "Config file not found"
- Ensure `infrastructure.yml` exists in repo root
- Run `npx infra init` to create example file

### "SSH connection failed"
- Verify SSH key is in GitHub Secrets with correct name (`STAGING_SSH` or `PROD_SSH`)
- Test SSH manually: `ssh -i ~/.ssh/key user@host`
- Check hostname/IP is correct
- Ensure firewall allows SSH (port 22)

### "Validation failed"
- Run `npx infra validate` to see specific errors
- Check required fields are present
- Verify YAML syntax is correct

### "GitHub secrets missing"
- Run `npx infra check-config` to see which secrets are missing
- Add missing secrets in GitHub Settings → Secrets
- Ensure secret names match expected format

### "Port conflict"
- The system auto-assigns ports, but you can specify a port in your config
- Run `npx infra check-config` to see port assignments
- Conflicts are automatically resolved

### "Service not starting"
- Check logs: `docker compose logs <service-name>`
- Verify config exists on server: `ls ~/infrastructure/configs/<repo-name>.yml`
- Run `npx infra check-config` to regenerate configs

## CLI Commands Summary

| Command | Description |
|---------|-------------|
| `npx infra init` | Create example `infrastructure.yml` file |
| `npx infra validate` | Validate config file locally |
| `npx infra check-config` | Check and regenerate configs on servers, verify GitHub secrets, provide report |
| `npx infra deploy` | Deploy/update config to servers |
| `npx infra remove` | Remove config from servers and clean up |
| `npx infra generate-workflows` | Generate GitHub Actions workflow files |

## Next Steps

- See **[README.md](README.md)** for full documentation
- See **[INITIAL_SETUP.md](INITIAL_SETUP.md)** for detailed server setup
- See **[REPO_SETUP.md](REPO_SETUP.md)** for adding new repositories
