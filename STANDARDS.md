# Factiii Stack Standards

This document defines the architecture, patterns, and requirements for Factiii Stack plugins.

## Plugin Categories

All plugins must belong to one of four categories:

### 1. PIPELINES
CI/CD systems that trigger deployments.

**Examples:** GitHub Actions, GitLab CI, Jenkins

**Responsibilities:**
- Generate workflow files
- Trigger deployments via SSH
- Manage pipeline secrets

### 2. SERVERS
Infrastructure where applications run.

**Examples:** Mac Mini, AWS EC2, Vercel, Ubuntu Server

**Responsibilities:**
- Provision infrastructure
- Deploy containers/applications
- Manage server configuration

### 3. FRAMEWORKS
Application frameworks and databases.

**Examples:** Prisma+tRPC, Next.js, Expo

**Responsibilities:**
- Detect framework presence
- Run migrations
- Build and prepare applications

### 4. ADDONS
Extensions to frameworks.

**Examples:** Auth (Clerk, Auth.js), Payments (Stripe), Storage (S3)

**Responsibilities:**
- Configure integrations
- Validate API keys
- Setup SDK clients

## Plugin Structure

### Required Static Properties

```javascript
class MyPlugin {
  // REQUIRED
  static id = 'my-plugin';           // Unique identifier
  static category = 'framework';      // pipeline|server|framework|addon
  static version = '1.0.0';          // Semantic version
  
  // REQUIRED: Config schemas
  static configSchema = {};          // User-editable (factiii.yml)
  static autoConfigSchema = {};      // Auto-detected (factiiiAuto.yml)
  
  // REQUIRED: Fixes array
  static fixes = [];                 // Issues this plugin can detect/fix
  
  // REQUIRED: shouldLoad method
  static async shouldLoad(rootDir, config = {}) {
    // Return true if plugin is relevant to this project
    return false;
  }
  
  // OPTIONAL
  static requiredEnvVars = [];       // Environment variables needed
  static helpText = {};              // Help text for secrets/config
}
```

### Config Schemas

#### configSchema - User-Editable Settings

Define settings that users must or can configure:

```javascript
static configSchema = {
  my_plugin: {
    api_key: 'EXAMPLE-your-api-key',  // EXAMPLE- prefix for required
    endpoint: 'https://api.example.com',
    timeout: 5000                       // Optional with default
  }
};
```

This gets merged into `factiii.yml`:

```yaml
name: my-app
environments: {...}
my_plugin:
  api_key: EXAMPLE-your-api-key
  endpoint: https://api.example.com
  timeout: 5000
```

#### autoConfigSchema - Auto-Detected Settings

Define what your plugin can auto-detect:

```javascript
static autoConfigSchema = {
  has_my_plugin: 'boolean',
  my_plugin_version: 'string',
  my_plugin_config_path: 'string'
};
```

#### shouldLoad() - Plugin Relevance Detection

Determine if this plugin should be loaded for the project:

```javascript
static async shouldLoad(rootDir, config = {}) {
  // Check if this plugin is relevant to the project
  // Called during 'npx factiii init' to decide which plugins to include
  
  const pkgPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  
  // Return true if plugin's dependencies are present
  return !!deps['my-plugin'];
}
```

**When shouldLoad() is called:**
- During `npx factiii init` - to determine which plugins to include in configs
- During `npx factiii scan/fix/deploy` - to load only relevant plugins

**Examples:**

```javascript
// Always load (pipeline plugins)
static async shouldLoad(rootDir, config = {}) {
  return true;
}

// Load if detected in package.json (framework plugins)
static async shouldLoad(rootDir, config = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return !!deps['my-framework'];
}

// Load if config exists or as default (server plugins)
static async shouldLoad(rootDir, config = {}) {
  // If config has our settings, load
  if (config?.my_server?.api_key) return true;
  
  // On init (no config), load as default
  return Object.keys(config).length === 0;
}
```

#### detectConfig() - Auto-Detection Logic

Implement detection logic:

```javascript
static async detectConfig(rootDir) {
  const pkgPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  
  if (!deps['my-plugin']) return null;
  
  return {
    has_my_plugin: true,
    my_plugin_version: deps['my-plugin'].replace(/^[\^~]/, ''),
    my_plugin_config_path: this.findConfig(rootDir)
  };
}
```

## Fixes Array

The `fixes` array is the core of the plugin system. Each fix defines:
- What to scan for (the `scan()` function)
- How to fix it (the `fix()` function)
- Manual instructions if auto-fix not possible

### Fix Structure

```javascript
static fixes = [
  {
    id: 'unique-fix-id',
    stage: 'dev',              // dev|secrets|staging|prod
    severity: 'critical',      // critical|warning|info
    description: 'Human-readable description',
    
    // Scan function - returns true if problem exists
    scan: async (config, rootDir) => {
      return !config.my_plugin?.api_key;
    },
    
    // Fix function - returns true if fixed successfully
    fix: async (config, rootDir) => {
      // Auto-fix logic
      return true;
    },
    
    // Manual fix instructions
    manualFix: 'Add api_key to factiii.yml'
  }
];
```

### The Four Stages

Every fix must specify which stage it applies to:

**dev** - Local development
- Check local dependencies
- Validate configuration files
- Ensure dev tools installed

**secrets** - GitHub/Pipeline secrets
- Validate GitHub secrets exist
- Check API keys are set
- Verify credentials

**staging** - Staging server
- Check server connectivity
- Validate staging environment
- Ensure staging database exists

**prod** - Production server
- Check production connectivity
- Validate production environment
- Ensure production database exists

### Severity Levels

**critical** - Blocks deployment
- Missing required configuration
- Invalid credentials
- Server unreachable

**warning** - Should be fixed but not blocking
- Outdated dependencies
- Suboptimal configuration
- Missing optional features

**info** - Informational only
- Suggestions for improvement
- Best practice recommendations

## Deploy Method

Every plugin must implement a `deploy()` method:

```javascript
async deploy(config, environment) {
  if (environment === 'dev') {
    // Start local development
    return this.deployDev(config);
  } else if (environment === 'staging') {
    // Deploy to staging
    return this.deployStaging(config);
  } else if (environment === 'prod') {
    // Deploy to production
    return this.deployProd(config);
  }
  
  return { success: false, error: 'Unsupported environment' };
}
```

Return format:

```javascript
{
  success: true|false,
  message: 'Optional success message',
  error: 'Optional error message'
}
```

## Environment Variables

Plugins can declare required environment variables:

```javascript
static requiredEnvVars = [
  'DATABASE_URL',
  'API_KEY',
  'SECRET_TOKEN'
];
```

The system automatically generates fixes to validate these exist in:
- `.env.example` (dev stage)
- `.env.staging` (staging stage)
- `.env.prod` (prod stage)

## Plugin Lifecycle

### 1. Load
Plugins are loaded from:
- `src/plugins/pipelines/`
- `src/plugins/servers/`
- `src/plugins/frameworks/`
- `src/plugins/addons/`
- `node_modules/@factiii/stack-plugin-*`

### 2. Scan
When `npx factiii scan` runs:
1. All plugins' `fixes` arrays are collected
2. Each fix's `scan()` function is called
3. Problems are grouped by stage
4. Results are displayed to user

### 3. Fix
When `npx factiii fix` runs:
1. Scan is run first to find problems
2. Fixes are reordered by stage (dev → secrets → staging → prod)
3. Each fix's `fix()` function is called
4. Manual fixes are displayed for unfixable issues

### 4. Deploy
When `npx factiii deploy --{env}` runs:
1. Scan is run first - aborts if problems found
2. Environment-specific `.env` file is loaded
3. Each plugin's `deploy()` method is called
4. Health checks are performed

## Example Plugin Implementation

```javascript
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class MyFrameworkPlugin {
  // ============================================================
  // STATIC METADATA
  // ============================================================
  
  static id = 'my-framework';
  static name = 'My Framework';
  static category = 'framework';
  static version = '1.0.0';
  
  static requiredEnvVars = ['DATABASE_URL'];
  
  // ============================================================
  // CONFIG SCHEMAS
  // ============================================================
  
  static configSchema = {
    my_framework: {
      migrations_path: null  // Optional override
    }
  };
  
  static autoConfigSchema = {
    has_my_framework: 'boolean',
    my_framework_version: 'string'
  };
  
  // ============================================================
  // AUTO-DETECTION
  // ============================================================
  
  static async detectConfig(rootDir) {
    const pkgPath = path.join(rootDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return null;
    
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    
    if (!deps['my-framework']) return null;
    
    return {
      has_my_framework: true,
      my_framework_version: deps['my-framework'].replace(/^[\^~]/, '')
    };
  }
  
  // ============================================================
  // FIXES
  // ============================================================
  
  static fixes = [
    {
      id: 'missing-my-framework',
      stage: 'dev',
      severity: 'info',
      description: 'My Framework not detected',
      scan: async (config, rootDir) => {
        const detected = await this.detectConfig(rootDir);
        return !detected;
      },
      fix: null,
      manualFix: 'Install: npm install my-framework'
    },
    {
      id: 'pending-migrations-staging',
      stage: 'staging',
      severity: 'warning',
      description: 'Database migrations pending on staging',
      scan: async (config, rootDir) => {
        // Check if migrations are pending
        return await this.hasPendingMigrations('staging');
      },
      fix: async (config, rootDir) => {
        await this.runMigrations('staging');
        return true;
      },
      manualFix: 'Run: npx my-framework migrate'
    }
  ];
  
  // ============================================================
  // DEPLOYMENT
  // ============================================================
  
  async deploy(config, environment) {
    if (environment === 'dev') {
      console.log('   Running dev migrations...');
      execSync('npx my-framework migrate:dev', { stdio: 'inherit' });
    } else {
      console.log(`   Running ${environment} migrations...`);
      execSync('npx my-framework migrate:deploy', { stdio: 'inherit' });
    }
    
    return { success: true, message: 'Migrations complete' };
  }
  
  // ============================================================
  // HELPER METHODS
  // ============================================================
  
  async hasPendingMigrations(environment) {
    // Implementation
  }
  
  async runMigrations(environment) {
    // Implementation
  }
}

module.exports = MyFrameworkPlugin;
```

## External Plugin Development

### 1. Create Plugin Package

```bash
mkdir my-factiii-plugin
cd my-factiii-plugin
npm init -y
```

### 2. Implement Plugin

Create `index.js` following the structure above.

### 3. Export Plugin

```javascript
// index.js
class MyPlugin {
  // ... implementation
}

module.exports = MyPlugin;
```

### 4. Publish

```bash
npm publish
```

### 5. Use in Projects

```bash
npm install my-factiii-plugin
```

Add to `factiii.yml`:

```yaml
plugins:
  - my-factiii-plugin
```

## Best Practices

### 1. Single Responsibility
Each plugin should handle one domain (one framework, one server type, etc.)

### 2. Idempotent Operations
Fixes and deployments should be safe to run multiple times.

### 3. Clear Error Messages
Always provide actionable error messages and manual fix instructions.

### 4. Fail Fast
Validate configuration early in the scan phase, not during deployment.

### 5. Minimal Workflows
Keep GitHub Actions workflows thin - just SSH and call CLI.

### 6. Test Locally
All deployment logic should be testable locally via `npx factiii deploy --dev`.

### 7. Document Everything
Provide clear `helpText` for all secrets and configuration options.

## Plugin Approval

To get your plugin approved and listed in `approved.json`:

1. Open a PR to this repository
2. Add your plugin to `src/plugins/approved.json`
3. Include:
   - Plugin source code or npm package link
   - Documentation
   - Example usage
   - Test results

Approved plugins load without warnings. Unapproved plugins show a warning but still work.

## Server-Side Architecture

### Multi-Repo Deployment

Factiii Stack supports deploying multiple repos to the same server. Each server runs a single nginx reverse proxy that routes to all deployed apps.

### Server Directory Structure

```
~/.factiii/                          # Root infrastructure directory
├── repo-name/                       # Each deployed repo
│   ├── factiii.yml                  # Repo config (scanned by generate-all.js)
│   ├── factiiiAuto.yml              # Auto-detected config
│   ├── .env.staging                 # Secrets (staging server only)
│   ├── .env.prod                    # Secrets (prod server only)
│   └── ... (source code if requiresFullRepo=true)
├── repo-name-2/                     # Another deployed repo
│   ├── factiii.yml
│   └── ...
├── scripts/
│   └── generate-all.js              # Regenerates merged configs
├── docker-compose.yml               # MERGED from all repos (generated)
└── nginx.conf                       # MERGED from all repos (generated)
```

**Key principle**: Staging and prod are **independent servers**. Each server only has its own environment's secrets.

### Pipeline Plugin: requiresFullRepo()

Pipeline plugins can declare whether they need the full repo cloned on the server:

```javascript
static requiresFullRepo(environment) {
  // Return true if full repo needed (for building from source)
  // Return false if only factiii.yml + env file needed (pulls pre-built images)
  return environment === 'staging';
}
```

**Factiii Pipeline defaults:**
- `staging` -> `true` (needs full repo to build locally)
- `prod` -> `false` (pulls pre-built images from ECR)

### The generate-all.js Script

This is the core server-side script that:

1. Scans `~/.factiii/*/factiii.yml` for all deployed repos
2. Generates a unified `docker-compose.yml` with all services
3. Generates a unified `nginx.conf` routing to all domains

Run it after any deployment to update configs:

```bash
node ~/.factiii/scripts/generate-all.js
```

### Deployment Flows

**Staging (requiresFullRepo = true):**
1. Workflow SSHs to staging server
2. Clone/pull full repo to `~/.factiii/{repo}/`
3. Write secrets to `~/.factiii/{repo}/.env.staging`
4. Run `generate-all.js` to regenerate merged configs
5. Build and start: `docker compose up -d {repo}-staging`

**Production (requiresFullRepo = false):**
1. Workflow SSHs to production server
2. Create `~/.factiii/{repo}/` with just `factiii.yml`
3. Write secrets to `~/.factiii/{repo}/.env.prod`
4. Run `generate-all.js` to regenerate merged configs
5. Pull image from ECR and start: `docker compose up -d {repo}-prod`

## Architecture Diagrams

### Plugin Lifecycle

```
┌─────────────┐
│   npx       │
│  factiii    │
└──────┬──────┘
       │
       ├─ scan ──────┐
       │             │
       ├─ fix ───────┼──► Load Plugins
       │             │
       └─ deploy ────┘
                     │
                     ▼
            ┌────────────────┐
            │ Plugin Loader  │
            └────────┬───────┘
                     │
         ┌───────────┼───────────┐
         │           │           │
    ┌────▼────┐ ┌───▼────┐ ┌───▼────┐
    │Pipeline │ │ Server │ │Framework│
    │ Plugins │ │Plugins │ │ Plugins │
    └─────────┘ └────────┘ └─────────┘
```

### Config Generation

```
Plugin.configSchema ──┐
                      ├──► Merge ──► factiii.yml
Plugin.configSchema ──┘

Plugin.detectConfig() ──┐
                        ├──► Merge ──► factiiiAuto.yml
Plugin.detectConfig() ──┘
```

### Deployment Flow

```
npx factiii deploy --staging
         │
         ├─ 1. Scan (abort if problems)
         │
         ├─ 2. Load .env.staging
         │
         ├─ 3. Call Plugin.deploy(config, 'staging')
         │      │
         │      ├─ Pipeline: Trigger workflow
         │      ├─ Server: Build & start containers
         │      └─ Framework: Run migrations
         │
         └─ 4. Health checks
```

## Summary

Factiii Stack's plugin architecture enables:
- **Modularity**: Each plugin handles one domain
- **Extensibility**: Easy to add new frameworks/servers
- **Testability**: All logic in JavaScript, not bash
- **Clarity**: Clear separation of concerns
- **Maintainability**: Config logic lives with the plugin

For questions or contributions, see the main repository.
