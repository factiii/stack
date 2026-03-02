# Stack

Infrastructure management CLI for deploying full-stack applications with plugin-based configuration.

## Quick Start

```bash
# Install in your project
npm install @factiii/stack

# Initialize configuration (run this first!)
npx stack init

# This creates:
# - stack.yml (user-editable config)
# - stackAuto.yml (auto-detected config)
# - .github/workflows/ (CI/CD workflows)

# Edit stack.yml to replace EXAMPLE_ values
# Then run:
npx stack scan    # Check for issues
npx stack fix     # Auto-fix issues
npx stack deploy --staging  # Deploy to staging
```

## How It Works

Stack uses a **plugin-based architecture** where each plugin:
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
npx stack init          # Initialize Stack
npx stack init --force  # Regenerate configs
```

**What it does:**
- Detects which plugins are relevant to your project
- Generates `stack.yml` with only relevant sections
- Generates `stackAuto.yml` with auto-detected values
- Creates GitHub Actions workflows

### Scan

Checks all environments for issues:

```bash
npx stack scan           # Scan all (dev, secrets, staging, prod)
npx stack scan --dev     # Scan dev only
npx stack scan --staging # Scan staging only
npx stack scan --prod    # Scan prod only
```

**Note:** Requires `stack.yml` (or legacy factiii.yml) to exist. Run `npx stack init` first.

### Fix

Automatically fixes issues where possible:

```bash
npx stack fix           # Fix all environments
npx stack fix --dev     # Fix dev only
npx stack fix --staging # Fix staging only
npx stack fix --prod    # Fix prod only
```

**Note:** Requires `stack.yml` (or legacy factiii.yml) to exist. Run `npx stack init` first.

### Deploy

Deploys to environments (runs scan first, aborts on issues):

```bash
npx stack deploy --dev      # Start local dev containers
npx stack deploy --staging  # Deploy to staging server
npx stack deploy --prod     # Deploy to production server
```

**Note:** Requires `stack.yml` (or legacy factiii.yml) to exist. Run `npx stack init` first.

### AWS EC2 Deployment (2 Commands)

Deploy your full-stack app to AWS EC2 with just two commands:

```bash
# 1. Provision all AWS infrastructure
npx factiii fix

# Creates: VPC, Security Groups, EC2 instance, RDS database,
# S3 bucket, ECR repository, IAM users, SES email

# 2. Deploy your application
npx factiii deploy --prod

# Configures: Docker, Nginx, SSL certificates, pulls images, starts containers
```

**Prerequisites:** You need an IAM user with the `factiii-bootstrap` policy configured via `aws configure`.

See [docs/aws-setup-guide.md](docs/aws-setup-guide.md) for the full step-by-step setup guide including the IAM policy JSON.

### Secrets Management

Manage secrets via Ansible Vault and deploy them directly to servers:

```bash
# List all secrets (SSH keys + environment variables)
npx stack deploy --secrets list

# Set SSH keys (required for deployment)
npx stack deploy --secrets set STAGING_SSH
npx stack deploy --secrets set PROD_SSH

# Set environment variables for each stage
npx stack deploy --secrets set-env DATABASE_URL --staging
npx stack deploy --secrets set-env JWT_SECRET --staging
npx stack deploy --secrets set-env DATABASE_URL --prod
npx stack deploy --secrets set-env JWT_SECRET --prod

# List environment variables
npx stack deploy --secrets list-env --staging
npx stack deploy --secrets list-env --prod

# Deploy secrets to servers via SSH
npx stack deploy --secrets deploy --staging  # Deploy to staging server
npx stack deploy --secrets deploy --prod     # Deploy to production server
npx stack deploy --secrets deploy --all      # Deploy to all servers

# Options
npx stack deploy --secrets deploy --staging --restart   # Restart container after deploy
npx stack deploy --secrets deploy --staging --dry-run   # Show what would be deployed
```

**How it works:**
1. Secrets are stored locally in Ansible Vault (encrypted)
2. When you run `secrets deploy`, Factiii:
   - Reads the SSH key from the vault
   - Connects to the server via SSH
   - Writes a `.env.{stage}` file with your environment variables
3. Your application reads the `.env.{stage}` file on startup

**Note:** Requires `stack.yml` with Ansible Vault configured. Run `npx stack init` first.

## Stage Execution

Stack commands work with four stages: `dev`, `secrets`, `staging`, `prod`.

### Running Commands

```bash
npx stack scan              # Scan all reachable stages
npx stack scan --dev        # Scan only dev stage
npx stack scan --staging    # Scan only staging stage

npx stack fix               # Fix all reachable stages
npx stack fix --staging     # Fix only staging stage

npx stack deploy --staging  # Deploy to staging
npx stack deploy --prod     # Deploy to prod
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
GITHUB_ACTIONS=true npx stack fix --staging     # ✅ Correct
npx stack fix                                    # ❌ Wrong - will try to run all stages
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
      GITHUB_ACTIONS=true npx stack deploy --staging
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
npx stack deploy --secrets list

# Set a secret (interactive prompt)
npx stack deploy --secrets set STAGING_SSH

# Set a secret (non-interactive)
npx stack deploy --secrets set STAGING_SSH --value "your-key-here"

# Check if secrets exist
npx stack deploy --secrets check
```

### Required Secrets

- **STAGING_SSH** - SSH private key for staging server
- **PROD_SSH** - SSH private key for production server
- **AWS_SECRET_ACCESS_KEY** - AWS secret key (if using AWS pipeline)

### CI/CD Integration

In GitHub Actions workflows, provide the vault password as a GitHub secret:

1. Add `ANSIBLE_VAULT_PASSWORD` to your repository secrets
2. Workflows automatically load SSH keys from Ansible Vault using this password

The workflow step `npx stack deploy --secrets write-ssh-keys` extracts secrets from the vault and writes SSH keys to `~/.ssh/` for deployment steps.

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
