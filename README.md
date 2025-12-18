# Factiii Stack

Infrastructure management CLI for deploying full-stack applications with plugin-based configuration.

## Quick Start

```bash
# Install in your project
npm install @factiii/stack

# Initialize configuration
npx factiii

# This creates:
# - factiii.yml (user-editable config)
# - factiiiAuto.yml (auto-detected config)
# - .github/workflows/ (CI/CD workflows)
```

## How It Works

Factiii Stack uses a **plugin-based architecture** where each plugin:
1. Defines its own configuration schema
2. Auto-detects project settings
3. Validates and fixes issues
4. Handles deployment for its domain

### The Two Config Files

**`factiii.yml`** - User-Editable Configuration
```yaml
name: my-app

environments:
  staging:
    domain: staging.myapp.com
    host: 192.168.1.100
  prod:
    domain: myapp.com
    host: 54.123.45.67

aws:
  config: free-tier  # or: ec2, standard, enterprise
  access_key_id: AKIAXXXXXXXX
  region: us-east-1

prisma:
  schema_path: null  # Optional override
  version: null      # Optional override
```

**`factiiiAuto.yml`** - Auto-Detected Configuration
```yaml
# Auto-detected by plugins
factiii_version: 1.0.0
has_prisma: true
has_trpc: true
prisma_schema: prisma/schema.prisma
prisma_version: 5.0.0
ssh_user: ubuntu
dockerfile: Dockerfile
package_manager: pnpm
node_version: 20
pnpm_version: 9
aws_cli_installed: true
```

## CLI Commands

### Scan

Checks all environments for issues:

```bash
npx factiii scan           # Scan all (dev, secrets, staging, prod)
npx factiii scan --dev     # Scan dev only
npx factiii scan --staging # Scan staging only
npx factiii scan --prod    # Scan prod only
```

### Fix

Automatically fixes issues where possible:

```bash
npx factiii fix           # Fix all environments
npx factiii fix --dev     # Fix dev only
npx factiii fix --staging # Fix staging only
npx factiii fix --prod    # Fix prod only
```

### Deploy

Deploys to environments (runs scan first, aborts on issues):

```bash
npx factiii deploy --dev      # Start local dev containers
npx factiii deploy --staging  # Deploy to staging server
npx factiii deploy --prod     # Deploy to production server
```

## The Four Stages

Every plugin operates across four stages:

1. **dev** - Local development environment
2. **secrets** - GitHub/pipeline secrets
3. **staging** - Staging server
4. **prod** - Production server

Each stage has its own:
- Configuration requirements
- Validation rules
- Deployment process

## Plugin Architecture

### Built-in Plugins

**Pipelines**
- `factiii` - GitHub Actions CI/CD with thin workflows

**Servers**
- `mac-mini` - Deploy to Mac Mini via SSH (staging)
- `aws` - Deploy to AWS (production)

**Frameworks**
- `prisma-trpc` - Prisma database + tRPC API

### How Plugins Work

Each plugin defines:

```javascript
class MyPlugin {
  static id = 'my-plugin';
  static category = 'framework'; // or: pipeline, server, addon
  
  // Schema for factiii.yml (user-editable)
  static configSchema = {
    my_plugin: {
      setting: 'default-value'
    }
  };
  
  // Schema for factiiiAuto.yml (auto-detected)
  static autoConfigSchema = {
    has_my_plugin: 'boolean',
    my_plugin_version: 'string'
  };
  
  // Auto-detect configuration
  static async detectConfig(rootDir) {
    return {
      has_my_plugin: true,
      my_plugin_version: '1.0.0'
    };
  }
  
  // Fixes array - issues this plugin can detect and resolve
  static fixes = [
    {
      id: 'missing-config',
      stage: 'dev',
      severity: 'critical',
      description: 'Configuration missing',
      scan: async (config, rootDir) => {
        // Return true if problem exists
        return !config.my_plugin;
      },
      fix: async (config, rootDir) => {
        // Auto-fix the problem
        return true;
      },
      manualFix: 'Add my_plugin config to factiii.yml'
    }
  ];
  
  // Deploy method
  async deploy(config, environment) {
    // Handle deployment for this environment
  }
}
```

## Thin Workflows

GitHub Actions workflows are intentionally minimal - they just SSH into servers and call the CLI:

```yaml
# .github/workflows/factiii-staging.yml
- name: Deploy via CLI
  run: |
    ssh user@host << EOF
      cd ~/.factiii/my-app
      git pull
      npx factiii deploy --staging
    EOF
```

All deployment logic runs on the server in testable JavaScript, not in workflow bash scripts.

## Environment Variables

Plugins declare required environment variables:

```javascript
class MyPlugin {
  static requiredEnvVars = ['DATABASE_URL', 'API_KEY'];
}
```

These are automatically validated against:
- `.env.example` (template, committed to git)
- `.env` (local dev, gitignored, auto-created from example)
- `.env.staging` (staging values, user creates)
- `.env.prod` (production values, user creates)

## AWS Configuration Bundles

The AWS plugin supports multiple configuration bundles:

```yaml
# factiii.yml
aws:
  config: free-tier  # Choose your bundle
  region: us-east-1
```

**Available Bundles:**
- `ec2` - Basic EC2 instance
- `free-tier` - Complete free tier (EC2 + RDS + S3 + ECR)
- `standard` - Production-ready setup (coming soon)
- `enterprise` - HA, multi-AZ, auto-scaling (coming soon)

## External Plugins

Install external plugins via npm:

```bash
npm install @factiii/stack-plugin-nextjs
```

Factiii automatically loads plugins from `node_modules` that match:
- `@factiii/stack-plugin-*`
- Listed in `factiii.yml` under `plugins`

## Development

See [STANDARDS.md](STANDARDS.md) for plugin development guide.

## License

MIT
