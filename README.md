# Infrastructure Repository

Centralized infrastructure management for multiple repositories across multiple servers (Mac Mini, EC2, etc.). All configuration lives in this repo - one-button deploy sets up everything automatically.

## Structure Overview

```
infrastructure/
├── infrastructure-config.yml  # Central config mapping servers to repos
├── infra.conf                # Environment config (staging/prod) - legacy/optional
├── repos/                    # Cloned repositories (gitignored)
├── secrets/                  # Environment files (gitignored)
├── actions-runner/           # GitHub Actions self-hosted runner (gitignored)
├── scripts/                  # Deployment and utility scripts
│   ├── deploy.sh
│   ├── validate-infra.sh
│   ├── parse-infrastructure-config.sh
│   ├── generate-nginx-config.sh
│   ├── generate-certbot-domains.sh
│   ├── write-env-file.sh
│   ├── setup-infrastructure.sh
│   ├── backup-all-dbs.sh
│   └── setup-repo.sh
├── .github/workflows/        # GitHub Actions workflows
│   ├── setup-infrastructure.yml
│   ├── deploy-infrastructure.yml
│   ├── deploy-on-repo-update.yml
│   ├── add-repo.yml
│   └── remove-repo.yml
├── nginx/                    # Nginx configuration
│   └── nginx.conf
├── docker-compose.yml        # Centralized Docker Compose configuration
└── README.md
```

## Quick Start

**New to infrastructure?** Start here:
- **[QUICK_START.md](QUICK_START.md)** - **NEW:** Centralized deployment guide (one-button deploy)
- **[INITIAL_SETUP.md](INITIAL_SETUP.md)** - Complete setup guide (git clone, docker, nginx, GitHub runner)
- **[REPO_SETUP.md](REPO_SETUP.md)** - What each repo needs to work with infrastructure

**Prerequisites:** Docker, Docker Compose, Git, PostgreSQL client tools. See [INITIAL_SETUP.md](INITIAL_SETUP.md) for full setup instructions.

## Centralized Architecture (Recommended)

**All configuration lives in the infrastructure repo:**
- `infrastructure-config.yml` - Maps servers to repos and environments
- GitHub Secrets - SSH keys and environment variables for all repos
- GitHub Actions Workflows - One-button deploy and auto-deployment

**Key Benefits:**
- Single source of truth for all configuration
- Multi-server support (Mac Mini, EC2, etc.)
- Auto-deployment when repos push to main/production
- No per-repo configuration needed

See **[QUICK_START.md](QUICK_START.md)** for complete setup and usage guide.

## Configuration

### Centralized Configuration (Recommended)

**Primary config:** `infrastructure-config.yml` maps servers to repos:

```yaml
servers:
  mac_mini:
    ssh_key_secret: MAC_MINI_SSH
    host: mac-mini.local
    user: jon
    repos:
      - name: factiii
        environment: staging
```

**GitHub Secrets:** All SSH keys and environment variables stored in infrastructure repo:
- SSH keys: `MAC_MINI_SSH`, `EC2_SSH`, etc.
- Environment variables: `FACTIII_STAGING_ENVS`, `FACTIII_PROD_ENVS`, etc.

See **[QUICK_START.md](QUICK_START.md)** for complete configuration guide.

### Legacy Configuration (Optional)

For backward compatibility, you can still use `infra.conf`:

```bash
# Infrastructure Configuration
INFRA_ENV=staging  # or "prod"
```

**Validate your setup:**
```bash
./scripts/validate-infra.sh
```

## Script Usage

### deploy.sh

Deploys a specific repository service.

**Usage:**
```bash
./scripts/deploy.sh <repo-name> [environment]
```

If environment is omitted, uses `INFRA_ENV` from `infra.conf`.

**Examples:**
```bash
./scripts/deploy.sh chop-shop          # Uses environment from infra.conf
./scripts/deploy.sh chop-shop prod     # Explicitly deploy to prod
./scripts/deploy.sh factiii staging    # Explicitly deploy to staging
```

**What it does:**
1. Pulls the infrastructure repository
2. Pulls the target repository from `repos/`
3. Builds the Docker image
4. Deploys the service via Docker Compose
5. Checks service health

### backup-all-dbs.sh

Backs up RDS databases to the Mac Mini.

**Usage:**
```bash
./scripts/backup-all-dbs.sh
```

**Configuration:**
1. Edit the `DATABASES` array in the script, or
2. Create `~/.rds-backup-config` with:
   ```bash
   DATABASES=(
       "db1:host1.rds.amazonaws.com:5432:user1:db1"
       "db2:host2.rds.amazonaws.com:5432:user2:db2"
   )
   ```

**Features:**
- Compressed backups using `gzip`
- Automatic cleanup (30 day retention)
- Stores backups in `~/rds-backups/`
- Requires `PGPASSWORD` environment variable or will prompt

**Automation:**
Add to crontab for daily backups:
```bash
0 2 * * * cd /path/to/infrastructure && ./scripts/backup-all-dbs.sh >> ~/backup.log 2>&1
```

### setup-repo.sh

Helper script to add new repositories to the infrastructure.

**Usage:**
```bash
./scripts/setup-repo.sh <repo-name> <git-url>
```

**Example:**
```bash
./scripts/setup-repo.sh my-new-repo https://github.com/user/my-new-repo.git
```

**What it does:**
1. Clones the repository to `repos/<repo-name>/`
2. Creates example `.env` files in `secrets/`
3. Provides next steps for configuration

### validate-infra.sh

Validates infrastructure configuration and reports missing items.

**Usage:**
```bash
./scripts/validate-infra.sh [--env staging|prod]
```

If `--env` is omitted, uses `INFRA_ENV` from `infra.conf`.

**What it checks:**
- Repos cloned in `repos/`
- Dockerfiles exist
- Deploy workflows exist
- Environment files in `secrets/`
- Docker Compose services defined
- Nginx server blocks configured
- GitHub Actions runner status
- SSL certificate configuration

**Example output:**
```
Infrastructure Validation (staging)
========================================

[chop-shop]
  ✓ Repo cloned at repos/chop-shop/
  ✓ Dockerfile exists
  ✓ Deploy workflow exists
  ✓ Env file: secrets/chop-shop-staging.env
  ✓ Docker Compose service: chop-shop-staging
  ✓ Nginx configured for staging-api.greasemoto.com

Runner Status
  ✓ GitHub Actions runner is running

Summary: 24/24 checks passed
```

## Docker Compose Services

### Application Services

Each repository has two services:
- `<repo-name>-prod`: Production environment
- `<repo-name>-staging`: Staging environment

**Current repositories:**
- `chop-shop` (ports: 5001)
- `factiii` (ports: 3001)
- `link3d` (ports: 3003)
- `tap-track` (ports: 3005)

### Shared Services

- **nginx**: Reverse proxy (ports 80, 443)
- **certbot**: SSL certificate management
- **postgres-staging**: Shared staging database (port 5432)

### Network

All services run on the `infrastructure_network` bridge network.

## Nginx Configuration

The nginx reverse proxy handles:
- SSL termination
- Domain-based routing
- ACME challenge support for Let's Encrypt
- Rate limiting
- Security headers

### Domain Routing

- `api.greasemoto.com` → `chop-shop-prod`
- `staging-api.greasemoto.com` → `chop-shop-staging`
- `factiii.greasemoto.com` → `factiii-prod`
- `staging-factiii.greasemoto.com` → `factiii-staging`
- `link3d.greasemoto.com` → `link3d-prod`
- `staging-link3d.greasemoto.com` → `link3d-staging`
- `tap-track.greasemoto.com` → `tap-track-prod`
- `staging-tap-track.greasemoto.com` → `tap-track-staging`

## GitHub Actions Setup

See **[INITIAL_SETUP.md](INITIAL_SETUP.md)** for self-hosted runner setup and **[REPO_SETUP.md](REPO_SETUP.md)** for workflow requirements and examples.

## Troubleshooting

### Service won't start

1. Check logs:
   ```bash
   docker-compose logs <service-name>
   ```

2. Verify environment files exist:
   ```bash
   ls -la secrets/<repo-name>-<env>.env
   ```

3. Check repository exists:
   ```bash
   ls -la repos/<repo-name>
   ```

### Health check failures

1. Verify the service exposes a `/health` endpoint
2. Check if the port in health check matches the service port
3. Review service logs for startup errors

### SSL certificate issues

1. Ensure domains point to the Mac Mini's IP
2. Check certbot logs:
   ```bash
   docker-compose logs certbot
   ```

3. Manually renew certificates:
   ```bash
   docker-compose run --rm certbot renew
   ```

### Database connection issues

1. Verify `postgres-staging` is healthy:
   ```bash
   docker-compose ps postgres-staging
   ```

2. Check connection string in `.env` files
3. Ensure staging services depend on `postgres-staging`

### Nginx not routing correctly

1. Test nginx configuration:
   ```bash
   docker-compose exec nginx nginx -t
   ```

2. Reload nginx:
   ```bash
   docker-compose exec nginx nginx -s reload
   ```

3. Check nginx logs:
   ```bash
   docker-compose logs nginx
   ```

## Adding New Repositories

See **[REPO_SETUP.md](REPO_SETUP.md)** for complete requirements, including:
- Required repo structure (Dockerfile, .env.example, workflow)
- Docker Compose configuration
- Nginx setup
- GitHub Secrets and workflow setup

## Maintenance

### Viewing logs
```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f <service-name>
```

### Updating services
```bash
# Update specific service
./scripts/deploy.sh <repo-name> <env>

# Rebuild all services
docker-compose build
docker-compose up -d
```

### Database backups
```bash
# Manual backup
./scripts/backup-all-dbs.sh

# View backups
ls -lh ~/rds-backups/
```

### SSL certificate renewal
```bash
# Manual renewal
docker-compose run --rm certbot renew
docker-compose restart nginx
```

## Security Notes

- Never commit `secrets/` directory to Git
- Use strong passwords for databases
- Regularly rotate API keys and secrets
- Keep Docker images updated
- Monitor logs for suspicious activity
- Use firewall rules to restrict access

## Support

For issues or questions:
1. Check the troubleshooting section
2. Review service logs
3. Verify configuration files
4. Check Docker and Docker Compose versions

