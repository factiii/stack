# Factiii Stack Standards

This document defines the architecture, plugin system, and development standards for the Factiii Stack infrastructure package.

## Philosophy

**Single Approach:** Base package with auto-scanning plugins.

Factiii scans your repository, identifies packages (Next.js, Expo, tRPC, Prisma), loads appropriate plugins, and handles deployment. Manual configuration is only required for settings that cannot be auto-detected.

---

## Plugin Architecture

Factiii uses a plugin system with 5 categories:

```
┌─────────────────────────────────────────────────────────────────────┐
│                     PLUGIN CATEGORIES                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. SECRETS     - Where credentials are stored                      │
│     └── github, aws-sm, vault, 1password                            │
│                                                                     │
│  2. SERVERS     - Where code runs (compute targets)                 │
│     ├── Simple: mac-mini, ubuntu-server                             │
│     ├── Bundled: aws-free-tier (EC2+RDS+ECR+S3)                     │
│     ├── Managed: vercel, fly-io, railway                            │
│     └── Kubernetes: aws-kubernetes, gke, self-hosted-k8s            │
│                                                                     │
│  3. FRAMEWORKS  - What gets deployed (app/service types)            │
│     ├── Apps: expo, nextjs, static                                  │
│     ├── Services: prisma-trpc-server, express                       │
│     └── Data: postgres, mysql, redis                                │
│                                                                     │
│  4. ADDONS      - Extensions that validate & enhance frameworks     │
│     └── auth, payments, storage, email, notifications               │
│                                                                     │
│  5. PIPELINES   - How code flows dev → staging → prod               │
│     └── github-actions, gitlab-ci, jenkins, manual                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### All Plugins Follow the Same Pattern

Every plugin implements the **init → init fix → deploy** pattern:

```javascript
class Plugin {
  // ============ INIT (scan) ============
  async scanDev(config)      // Check local requirements
  async scanGitHub(config)   // Check GitHub secrets exist
  async scanServer(config)   // Check server state
  
  // ============ INIT FIX ============
  async fixDev(issues)       // Fix local issues
  async fixGitHub(issues)    // Upload secrets to GitHub
  // NOTE: fixServer() is reserved for deploy
  
  // ============ DEPLOY ============
  async deploy(config)       // Deploy to server
  async undeploy(config)     // Remove from server
  
  // ============ METADATA ============
  static requiredSecrets     // What secrets this plugin needs
  static factiiiYmlSettings     // Manual settings (user configures)
  static factiiiAutoSettings    // Auto-detected settings
  static capabilities        // What this plugin provides
}
```

---

## Init/Fix/Deploy Pattern

### The Fundamental Principle

For **every issue** a plugin can detect, it MUST provide:

1. **SCAN function** - Detects the issue
2. **FIX function** - Resolves the issue (or `null` if manual fix required)
3. **EXPLANATION** - How to fix manually if no auto-fix
4. **STAGE** - Which stage this applies to (dev/github/staging/prod)

### Issue Structure

```javascript
{
  id: 'missing-ssh-key',
  stage: 'github',           // dev | github | staging | prod
  severity: 'critical',      // critical | warning | info
  description: 'STAGING_SSH secret not found in GitHub',
  canAutoFix: true,
  fix: async () => { /* upload secret */ },
  manualFix: 'Go to GitHub Settings → Secrets → Add STAGING_SSH'
}
```

### Command Behavior by Stage

| Command | Dev | GitHub | Staging/Prod |
|---------|-----|--------|--------------|
| `init` | Scan + auto-fix minor | Scan only | Scan only |
| `init fix` | Fix all | Fix all | WARN only (shows pending) |
| `deploy` | Scan | Scan | Fix + Deploy |

### Stage Progression

Plugins must understand what's required to reach the next stage:

```
DEV → GITHUB → STAGING → PROD
 │       │         │        │
 │       │         │        └── Requires: PROD_SSH
 │       │         └── Requires: STAGING_SSH  
 │       └── Requires: GITHUB_TOKEN, workflows pushed
 └── Requires: factiii.yml, factiiiAuto.yml
```

### What Each Stage Can Fix

**Dev (local):**
- Generate factiiiAuto.yml
- Generate workflows
- Update .gitignore
- Create env templates
- Install dependencies

**GitHub (via API):**
- Upload secrets (SSH keys, env vars)
- Cannot: modify workflows (must be pushed via git)

**Staging/Prod (via workflow/SSH):**
- Upload factiii.yml as {repo}.yml
- Regenerate docker-compose.yml
- Regenerate nginx.conf
- Deploy containers
- Run migrations

---

## Universal Interfaces

Plugins can implement **universal interfaces** for interoperability. If two plugins implement the same interface, they use the same config and can work together.

### Universal Environment Variables

```javascript
// Plugins MUST use these if they provide the capability

// ============ DATABASE ============
DATABASE_URL        // Primary connection string
DATABASE_URL_READ   // Read replica (optional)
DATABASE_POOL_SIZE  // Connection pool size

// ============ STORAGE ============
STORAGE_URL         // Object storage endpoint
STORAGE_BUCKET      // Default bucket name
STORAGE_ACCESS_KEY  // Access key (secret)
STORAGE_SECRET_KEY  // Secret key (secret)

// ============ CACHE ============
CACHE_URL           // Cache connection string (redis://host:6379)

// ============ EMAIL ============
EMAIL_FROM          // Default from address
EMAIL_PROVIDER_URL  // Email API endpoint
EMAIL_API_KEY       // Email service API key (secret)

// ============ SITE ============
SITE_URL            // Public URL of the site
API_URL             // API endpoint URL
CDN_URL             // CDN URL for assets

// ============ AUTH ============
AUTH_SECRET         // Secret for signing tokens (secret)
AUTH_URL            // Auth callback URL
```

### Universal Settings

Standard settings that plugins can implement:

```yaml
# REPLICATION - For databases that support it
replication:
  enabled: true
  mode: async           # async | sync | semi-sync
  replicas:
    - target: production-replica
      role: read        # read | failover | backup

# BACKUP - For databases and storage
backup:
  enabled: true
  schedule: daily       # hourly | daily | weekly
  retention_days: 7
  storage: s3-backup    # Reference to storage plugin

# SCALING - For servers that support it
scaling:
  enabled: false
  min_instances: 1
  max_instances: 3
  target_cpu: 70
  target_memory: 80

# HEALTH CHECK - For all deployable apps
healthCheck:
  endpoint: /health
  interval_seconds: 30
  timeout_seconds: 5
  healthy_threshold: 2
  unhealthy_threshold: 3

# LOGGING - All frameworks should support
logging:
  level: info           # debug | info | warn | error
  format: json          # json | text
  destination: stdout   # stdout | file | service
```

### Interface Compatibility

Plugins that implement the same interface can work together:

| Interface | Env Vars | Settings | Implemented By |
|-----------|----------|----------|----------------|
| **Database** | DATABASE_URL | replication, backup | postgres, mysql, aws-rds |
| **Storage** | STORAGE_URL, STORAGE_BUCKET | backup, lifecycle | s3, gcs, minio |
| **Cache** | CACHE_URL | clustering, eviction | redis, memcached |
| **Email** | EMAIL_FROM, EMAIL_API_KEY | templates, rate_limit | ses, sendgrid, postmark |

---

## Framework/Server Compatibility

Frameworks declare requirements, servers declare capabilities:

```
┌──────────────────────────────────────────────────────────────────────────┐
│                     FRAMEWORK / SERVER COMPATIBILITY                     │
├────────────────┬─────────┬────────┬──────────────┬────────┬─────────────┤
│                │mac-mini │ ubuntu │aws-free-tier │ vercel │ aws-k8s     │
├────────────────┼─────────┼────────┼──────────────┼────────┼─────────────┤
│ expo           │  ✓ full │ ✓ droid│      ✓       │   ✗    │     ✓       │
│ nextjs         │    ✓    │   ✓    │      ✓       │ ✓ best │     ✓       │
│ prisma-server  │  ✓ ext  │ ✓ ext  │    ✓ rds     │   ✗    │   ✓ ext     │
│ postgres       │    ✓    │   ✓    │    ✓ rds     │   ✗    │     ✓       │
│ static         │    ✓    │   ✓    │      ✓       │   ✓    │     ✓       │
├────────────────┴─────────┴────────┴──────────────┴────────┴─────────────┤
│ Legend: ✓ = supported, ✗ = not supported                                │
│         full = full iOS+Android, droid = Android only                   │
│         ext = external DB required, rds = managed DB included           │
│         best = optimized for this platform                              │
└──────────────────────────────────────────────────────────────────────────┘
```

**Note:** Addons can further extend compatibility requirements. For example, the `auth` addon requires specific models in the Prisma schema.

---

## Addons (Framework Extensions)

Addons extend base frameworks with validation and enhanced functionality. They don't deploy independently - they validate and enhance the frameworks they attach to.

### How Addons Work

```
┌─────────────────────────────────────────────────────────────────────┐
│                     FRAMEWORK + ADDON COMPOSITION                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  BASE FRAMEWORK: prisma-trpc-server                                 │
│     └── Scans for: schema.prisma, trpc routes                       │
│                                                                     │
│  ADDONS (extend & validate):                                        │
│     ├── auth      - Validates: User model, Session model, routes    │
│     ├── payments  - Validates: Subscription model, Stripe config    │
│     ├── storage   - Validates: File model, upload routes            │
│     └── email     - Validates: EmailTemplate model, send config     │
│                                                                     │
│  ADDON COMPATIBILITY:                                               │
│     └── auth addon works with: prisma-trpc-server, nextjs, expo     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Addon Interface

Addons follow the same init/fix/deploy pattern but declare which frameworks they're compatible with:

```javascript
class AuthAddon extends Addon {
  static id = 'auth';
  static category = 'addon';
  
  // Which frameworks this addon can extend
  static compatibleWith = ['prisma-trpc-server', 'nextjs', 'expo'];
  
  // Schema requirements (for Prisma-based frameworks)
  static schemaRequirements = {
    models: ['User', 'Session'],
    fields: {
      User: ['id', 'email', 'passwordHash', 'createdAt'],
      Session: ['id', 'userId', 'token', 'expiresAt']
    }
  };
  
  // Route requirements (for tRPC-based frameworks)
  static routeRequirements = [
    'auth.login',
    'auth.logout',
    'auth.register',
    'auth.refresh'
  ];
  
  // Secrets this addon needs
  static requiredSecrets = ['AUTH_SECRET'];
  
  // Settings in factiii.yml
  static factiiiYmlSettings = {
    jwt: {
      access_expiry: '15m',
      refresh_expiry: '7d'
    }
  };
  
  async scanDev(config) {
    const issues = [];
    // Validate schema.prisma has required models
    // Validate trpc has required routes
    // Check JWT config exists
    return issues;
  }
}
```

### Deployment Options

Addons can be deployed in different ways:

| Option | Description | Use Case |
|--------|-------------|----------|
| **Embedded** | Addon code runs inside the base framework | Simple apps, single container |
| **Sidecar** | Addon runs as separate container on same server | Microservices, isolation |
| **Split** | Addon runs on different server entirely | Scale independently |

### factiii.yml with Addons

```yaml
apps:
  # Embedded: auth runs inside the server
  - framework: prisma-trpc-server
    path: apps/server
    addons:
      - auth
      - payments
    auth:
      jwt:
        access_expiry: 15m
        refresh_expiry: 7d
    
  # The auth addon also validates these frameworks
  - framework: nextjs
    path: apps/web
    addons:
      - auth    # Validates auth context, middleware
    
  - framework: expo
    path: apps/mobile
    addons:
      - auth    # Validates auth storage, token handling
```

### Available Addons (Planned)

| Addon | Compatible With | Validates |
|-------|-----------------|-----------|
| **auth** | prisma-trpc-server, nextjs, expo | User/Session models, JWT config, auth routes |
| **payments** | prisma-trpc-server | Subscription model, Stripe config, webhook routes |
| **storage** | prisma-trpc-server | File model, S3 config, upload routes |
| **email** | prisma-trpc-server | Email templates, provider config |
| **notifications** | prisma-trpc-server, expo | Push tokens, notification routes |

---

## Configuration Standards

### Two Configuration Files

| File | Purpose | Editable By |
|------|---------|-------------|
| `factiii.yml` | Settings that **cannot** be auto-detected | User (manual) |
| `factiiiAuto.yml` | Settings that **are** auto-detected | Factiii (automatic) |

### factiii.yml (Manual Settings)

Use the `EXAMPLE-` prefix for settings that need user input:

```yaml
name: EXAMPLE-myapp
ssl_email: EXAMPLE-admin@example.com

aws:
  access_key_id: EXAMPLE-AKIAXXXXXXXXXXXXXXXX
  region: us-east-1

environments:
  staging:
    domain: EXAMPLE-staging.myapp.com
    host: EXAMPLE-192.168.1.100
```

**Factiii blocks deployment if any `EXAMPLE-` values remain.**

### factiiiAuto.yml (Auto-Detected Settings)

Generated by `npx factiii init`. Override with the `OVERRIDE` keyword:

```yaml
# Auto-detected
ssh_user: ubuntu
prisma_schema: apps/server/prisma/schema.prisma

# User override
dockerfile: apps/server/Dockerfile OVERRIDE custom/Dockerfile
```

---

## Secrets vs Configuration

Factiii minimizes secrets by putting non-sensitive values in config files.

### What Goes Where

| Setting | Location | Why |
|---------|----------|-----|
| `{ENV}_SSH` | GitHub Secrets | SSH private keys are sensitive |
| `AWS_SECRET_ACCESS_KEY` | GitHub Secrets | AWS secret is sensitive |
| `{ENV}_ENVS` | GitHub Secrets (optional) | App environment variables |
| `aws.access_key_id` | factiii.yml | Identifies AWS user, not secret |
| `aws.region` | factiii.yml | Not secret |
| `environments.{env}.host` | factiii.yml | Server IP/hostname, not secret |
| `ssh_user` | factiiiAuto.yml | Defaults to ubuntu |

### Required GitHub Secrets (Minimal)

| Secret | Description |
|--------|-------------|
| `STAGING_SSH` | SSH private key for staging server |
| `PROD_SSH` | SSH private key for production server |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key (only secret AWS value) |

---

## Commands

### `npx factiii init`

**Purpose:** Scan everything, auto-fix dev only, report all issues.

**What it does:**
- **Dev:** Scan + auto-fix (generate configs, install deps)
- **GitHub:** Scan only (check secrets exist)
- **Servers:** Scan only (check deployment state)

**Output:** Full report of all issues with what `init fix` would change.

### `npx factiii init fix`

**Purpose:** Fix dev + GitHub issues, warn about server issues.

**What it does:**
1. Runs `init` first to discover all issues
2. Fixes all dev issues
3. Uploads missing secrets to GitHub
4. Reports pending server changes (for deploy to handle)

**Does NOT:** Deploy containers, modify nginx/docker-compose on servers.

### `npx factiii deploy`

**Purpose:** Run init, then fix servers and deploy.

**What it does:**
1. Runs `init` - blocks if critical issues
2. Uploads factiii.yml to servers
3. Regenerates nginx/docker-compose
4. Deploys containers
5. Runs migrations (production only)

---

## Pipeline Configuration

The `github-actions` pipeline (default) generates these workflows:

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `factiii-deploy.yml` | Manual (npx factiii deploy) | Direct deployment |
| `factiii-staging.yml` | PR/push to main | Auto-deploy to staging |
| `factiii-production.yml` | Merge to production | Auto-deploy to production |
| `factiii-undeploy.yml` | Manual | Cleanup/remove deployment |

---

## Current Status & Roadmap

### Currently Implemented

- Factiii engine with init/init fix/deploy commands
- Secrets plugin: `github`
- Server plugins: `mac-mini`, `aws-ec2` (partial)
- Pipeline: `github-actions` (hardcoded)
- Framework detection: Prisma only

### Roadmap

| Phase | Plugin | Description |
|-------|--------|-------------|
| 1 | **Factiii Stack** | Stabilize plugin architecture (Current) |
| 2 | **Expo** | Mobile app builds (iOS + Android) |
| 3 | **Prisma/tRPC Server** | API server framework |
| 4 | **AWS Free Tier** | Bundled EC2 + RDS + ECR + S3 |
| 5 | **Next.js/Vercel** | Managed Next.js hosting |
| 6 | **Next.js/Server** | Self-hosted Next.js |

### Future Universal Interfaces

- Database replication across clouds (postgres ↔ aws-rds)
- Cross-platform storage (S3-compatible everywhere)
- Unified logging and monitoring
- Multi-cloud deployments

---

## Development in This Repository

**Important:** This repository IS the Factiii Stack package itself.

**DO NOT** run `npx factiii` commands inside this repository.

### Testing Changes

```bash
cd /path/to/test-app
npm link /path/to/infrastructure
npx factiii init
```

### Key Directories

```
/infrastructure/
├── bin/factiii              # CLI entry point
├── src/
│   ├── cli/              # Command implementations
│   ├── plugins/          # Plugin implementations
│   │   ├── secrets/      # Secrets plugins (github, etc.)
│   │   ├── server/       # Server plugins (mac-mini, etc.)
│   │   └── interfaces/   # Plugin interfaces
│   ├── generators/       # Config generators
│   ├── universal/        # Universal interfaces & env vars
│   ├── utils/            # Utilities
│   └── workflows/        # Workflow templates
├── templates/            # Config templates
└── test/                 # Test suites
```

---

## Writing Plugins

### Plugin Checklist

Every plugin MUST:

1. Implement `scanDev()`, `scanGitHub()`, `scanServer()`
2. Implement `fixDev()`, `fixGitHub()`
3. Implement `deploy()`, `undeploy()`
4. Define `requiredSecrets` - what secrets it needs
5. Define `factiiiYmlSettings` - manual settings
6. Define `factiiiAutoSettings` - auto-detected settings
7. For every issue it can detect, provide a fix or explanation

### Plugin Template

```javascript
const { Plugin } = require('@factiii/stack');

class MyPlugin extends Plugin {
  static id = 'my-plugin';
  static category = 'framework';  // secrets | server | framework | pipeline
  
  static requiredSecrets = ['MY_API_KEY'];
  
  static factiiiYmlSettings = {
    my_setting: 'EXAMPLE-value'
  };
  
  static factiiiAutoSettings = {
    detected_setting: null  // Will be auto-detected
  };
  
  async scanDev(config) {
    const issues = [];
    // Check for issues, add to array
    return issues;
  }
  
  async fixDev(issues) {
    for (const issue of issues) {
      if (issue.canAutoFix) {
        await issue.fix();
      }
    }
  }
  
  async deploy(config) {
    // Deploy logic
  }
}

module.exports = MyPlugin;
```

### Using Universal Interfaces

If your plugin provides a universal capability, use the standard env vars:

```javascript
class PostgresPlugin extends Plugin {
  static implements = ['database', 'replication', 'backup'];
  
  // Use universal env vars
  static envVars = {
    DATABASE_URL: { required: true },
    DATABASE_URL_READ: { required: false }
  };
  
  // Use universal settings
  static settings = {
    replication: UniversalSettings.replication,
    backup: UniversalSettings.backup
  };
}
```

This ensures your plugin is compatible with any other plugin that uses the database interface.
