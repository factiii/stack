# Infrastructure Repository

Centralized infrastructure management for multiple repositories on Mac Mini.

## Structure Overview

```
infrastructure/
├── repos/              # Cloned repositories (gitignored)
├── secrets/            # Environment files (gitignored)
├── scripts/            # Deployment and utility scripts
│   ├── deploy.sh
│   ├── backup-all-dbs.sh
│   └── setup-repo.sh
├── nginx/              # Nginx configuration
│   └── nginx.conf
├── docker-compose.yml  # Centralized Docker Compose configuration
└── README.md
```

## Quick Start Guide

### Prerequisites

- Docker and Docker Compose installed
- Git configured
- PostgreSQL client tools (for backups)
- Access to all repository Git URLs

### Initial Setup

1. **Clone this infrastructure repository:**
   ```bash
   git clone <infrastructure-repo-url> infrastructure
   cd infrastructure
   ```

2. **Set up repositories:**
   ```bash
   ./scripts/setup-repo.sh chop-shop <git-url>
   ./scripts/setup-repo.sh factiii <git-url>
   ./scripts/setup-repo.sh link3d <git-url>
   ./scripts/setup-repo.sh tap-track <git-url>
   ```

3. **Configure environment variables:**
   - Edit `.env` files in `secrets/` directory for each service
   - Set database credentials, API keys, etc.

4. **Set up SSL certificates:**
   ```bash
   docker-compose up certbot
   ```

5. **Start all services:**
   ```bash
   docker-compose up -d
   ```

## Script Usage

### deploy.sh

Deploys a specific repository service.

**Usage:**
```bash
./scripts/deploy.sh <repo-name> <environment>
```

**Examples:**
```bash
./scripts/deploy.sh chop-shop prod
./scripts/deploy.sh factiii staging
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

### Workflow Example

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: self-hosted
    steps:
      - name: Deploy to Production
        run: |
          cd /path/to/infrastructure
          ./scripts/deploy.sh ${{ github.event.repository.name }} prod
```

### Self-Hosted Runner Setup

1. Install GitHub Actions runner on Mac Mini
2. Configure runner to have access to infrastructure directory
3. Ensure Docker and Docker Compose are available to runner
4. Set up SSH keys or deploy tokens for repository access

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

1. **Run setup script:**
   ```bash
   ./scripts/setup-repo.sh <repo-name> <git-url>
   ```

2. **Edit environment files:**
   - `secrets/<repo-name>-prod.env`
   - `secrets/<repo-name>-staging.env`

3. **Add services to `docker-compose.yml`:**
   ```yaml
   <repo-name>-prod:
     build:
       context: ./repos/<repo-name>
       dockerfile: apps/server/Dockerfile
     container_name: <repo-name>-prod
     environment:
       - NODE_ENV=production
     env_file:
       - ./secrets/<repo-name>-prod.env
     networks:
       - infrastructure_network
     restart: unless-stopped
     healthcheck:
       test: ["CMD", "curl", "-f", "http://localhost:<port>/health"]
       interval: 30s
       timeout: 10s
       retries: 3
       start_period: 40s

   <repo-name>-staging:
     build:
       context: ./repos/<repo-name>
       dockerfile: apps/server/Dockerfile
     container_name: <repo-name>-staging
     environment:
       - NODE_ENV=staging
     env_file:
       - ./secrets/<repo-name>-staging.env
     networks:
       - infrastructure_network
     restart: unless-stopped
     depends_on:
       postgres-staging:
         condition: service_healthy
     healthcheck:
       test: ["CMD", "curl", "-f", "http://localhost:<port>/health"]
       interval: 30s
       timeout: 10s
       retries: 3
       start_period: 40s
   ```

4. **Add nginx server blocks** in `nginx/nginx.conf` for domain routing

5. **Update certbot command** in `docker-compose.yml` to include new domains

6. **Deploy:**
   ```bash
   ./scripts/deploy.sh <repo-name> prod
   ./scripts/deploy.sh <repo-name> staging
   ```

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

