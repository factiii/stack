# Factiii Stack

Infrastructure management CLI for deploying full-stack applications with plugin-based configuration.

## Quick Start

```bash
# Install in your project
npm install @factiii/stack

# Initialize configuration (run this first!)
npx factiii init

# This creates:
# - stack.yml (user-editable config)
# - stackAuto.yml (auto-detected config)
# - .github/workflows/ (CI/CD workflows)

# Edit stack.yml to replace EXAMPLE- values
# Then run:
npx factiii scan    # Check for issues
npx factiii fix     # Auto-fix issues
npx factiii deploy --staging  # Deploy to staging
```

## How It Works

Factiii Stack uses a **plugin-based architecture** where each plugin:
1. Defines its own configuration schema
2. Auto-detects project settings
3. Validates and fixes issues
4. Handles deployment for its domain

### The Two Config Files

**`stack.yml`** - User-Editable Configuration
```yaml
name: my-app

# Environment configurations
staging:
  domain: staging.myapp.com
  server: mac             # OS type: mac, ubuntu, windows, amazon-linux
  server_mode: true       # Enable server hardening (default: true)

prod:
  domain: myapp.com
  server: ubuntu          # OS type for production
  pipeline: aws           # Use AWS pipeline for deployment
  config: free-tier       # AWS tier: ec2, free-tier, standard, enterprise
  access_key_id: AKIAXXXXXXXX
  region: us-east-1

prisma:
  schema_path: null  # Optional override
  version: null      # Optional override

# Exclude Docker containers from unmanaged container cleanup
container_exclusions:
  - factiii_postgres
  - legacy_container
```

**`stackAuto.yml`** - Auto-Detected Configuration
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

### Init (Run This First!)

Scans your project and generates configuration files:

```bash
npx factiii init          # Initialize Factiii Stack
npx factiii init --force  # Regenerate configs
```

**What it does:**
- Detects which plugins are relevant to your project
- Generates `stack.yml` with only relevant sections
- Generates `stackAuto.yml` with auto-detected values
- Creates GitHub Actions workflows

### Scan

Checks all environments for issues:

```bash
npx factiii scan           # Scan all (dev, secrets, staging, prod)
npx factiii scan --dev     # Scan dev only
npx factiii scan --staging # Scan staging only
npx factiii scan --prod    # Scan prod only
```

**Note:** Requires `stack.yml` (or legacy factiii.yml) to exist. Run `npx factiii init` first.

### Fix

Automatically fixes issues where possible:

```bash
npx factiii fix           # Fix all environments
npx factiii fix --dev     # Fix dev only
npx factiii fix --staging # Fix staging only
npx factiii fix --prod    # Fix prod only
```

**Note:** Requires `stack.yml` (or legacy factiii.yml) to exist. Run `npx factiii init` first.

### Deploy

Deploys to environments (runs scan first, aborts on issues):

```bash
npx factiii deploy --dev      # Start local dev containers
npx factiii deploy --staging  # Deploy to staging server
npx factiii deploy --prod     # Deploy to production server
```

**Note:** Requires `stack.yml` (or legacy factiii.yml) to exist. Run `npx factiii init` first.

### Secrets Management

Manage secrets via Ansible Vault and deploy them directly to servers:

```bash
# List all secrets (SSH keys + environment variables)
npx factiii secrets list

# Set SSH keys (required for deployment)
npx factiii secrets set STAGING_SSH
npx factiii secrets set PROD_SSH

# Set environment variables for each stage
npx factiii secrets set-env DATABASE_URL --staging
npx factiii secrets set-env JWT_SECRET --staging
npx factiii secrets set-env DATABASE_URL --prod
npx factiii secrets set-env JWT_SECRET --prod

# List environment variables
npx factiii secrets list-env --staging
npx factiii secrets list-env --prod

# Deploy secrets to servers via SSH
npx factiii secrets deploy --staging  # Deploy to staging server
npx factiii secrets deploy --prod     # Deploy to production server
npx factiii secrets deploy --all      # Deploy to all servers

# Options
npx factiii secrets deploy --staging --restart   # Restart container after deploy
npx factiii secrets deploy --staging --dry-run   # Show what would be deployed
```

**How it works:**
1. Secrets are stored locally in Ansible Vault (encrypted)
2. When you run `secrets deploy`, Factiii:
   - Reads the SSH key from the vault
   - Connects to the server via SSH
   - Writes a `.env.{stage}` file with your environment variables
3. Your application reads the `.env.{stage}` file on startup

**Note:** Requires `stack.yml` with Ansible Vault configured. Run `npx factiii init` first.

## Stage Execution

Factiii commands work with four stages: `dev`, `secrets`, `staging`, `prod`.

### Running Commands

```bash
npx factiii scan              # Scan all reachable stages
npx factiii scan --dev        # Scan only dev stage
npx factiii scan --staging    # Scan only staging stage

npx factiii fix               # Fix all reachable stages
npx factiii fix --staging     # Fix only staging stage

npx factiii deploy --staging  # Deploy to staging
npx factiii deploy --prod     # Deploy to prod
```

### How Stages Are Reached

The pipeline plugin decides how to reach each stage:

| Stage | How it's reached |
|-------|------------------|
| dev | Always runs locally |
| secrets | Runs locally (needs Ansible Vault configured) |
| staging | Via workflow → SSH → runs with `--staging` |
| prod | Via workflow → SSH → runs with `--prod` |

### For Pipeline Plugin Authors

When your CI/CD workflow SSHs to a server to run commands, you **MUST** specify the stage:

```bash
# In your workflow, after SSH to staging server:
GITHUB_ACTIONS=true npx factiii fix --staging     # ✅ Correct
npx factiii fix                                    # ❌ Wrong - will try to run all stages
```

This prevents the command from trying to reach stages it can't access from the server.

See [STANDARDS.md](STANDARDS.md) for full documentation of the stage execution pattern.

## Plugin Architecture

### Built-in Plugins

**Pipelines**
- `factiii` - GitHub Actions CI/CD with thin workflows
- `aws` - AWS infrastructure (EC2, ECR, free-tier configs)

**Servers (OS Types)**
- `mac` - macOS (Homebrew, launchctl)
- `ubuntu` - Ubuntu Linux (apt, systemd)
- `windows` - Windows Server (Chocolatey) - template
- `amazon-linux` - Amazon Linux 2023 (dnf, systemd)

**Frameworks**
- `prisma-trpc` - Prisma database + tRPC API

**Addons**
- `server-mode` - Configure machines as deployment servers (disable sleep, enable SSH, etc.)

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
      GITHUB_ACTIONS=true npx factiii deploy --staging
    EOF
```

**CRITICAL: Workflows MUST specify the stage flag (`--staging` or `--prod`) when running commands on servers.**

All deployment logic runs on the server in testable JavaScript, not in workflow bash scripts.

## Secrets Management

Factiii uses **Ansible Vault** to store and manage deployment secrets (SSH keys, API keys, etc.).

### Configuration

Add Ansible Vault configuration to `factiii.yml`:

```yaml
# Ansible Vault configuration (for secrets)
ansible:
  vault_path: group_vars/all/vault.yml  # Path to vault file
  vault_password_file: ~/.vault_pass    # Optional: path to password file
```

### Vault Password

Provide the vault password via one of:
- **Password file:** Set `ansible.vault_password_file` in `factiii.yml` (e.g. `~/.vault_pass`)
- **Environment variable:** `ANSIBLE_VAULT_PASSWORD` or `ANSIBLE_VAULT_PASSWORD_FILE`

**Security:** Never commit the vault password or decrypted vault file to git.

### Managing Secrets

```bash
# List all secrets
npx factiii secrets list

# Set a secret (interactive prompt)
npx factiii secrets set STAGING_SSH

# Set a secret (non-interactive)
npx factiii secrets set STAGING_SSH --value "your-key-here"

# Check if secrets exist
npx factiii secrets check
```

### Required Secrets

- **STAGING_SSH** - SSH private key for staging server
- **PROD_SSH** - SSH private key for production server
- **AWS_SECRET_ACCESS_KEY** - AWS secret key (if using AWS pipeline)

### CI/CD Integration

In GitHub Actions workflows, provide the vault password as a GitHub secret:

1. Add `ANSIBLE_VAULT_PASSWORD` to your repository secrets
2. Workflows automatically load SSH keys from Ansible Vault using this password

The workflow step `npx factiii secrets write-ssh-keys` extracts secrets from the vault and writes SSH keys to `~/.ssh/` for deployment steps.

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
