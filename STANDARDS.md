# Factiii Stack Standards

This document defines the architecture, patterns, and requirements for Factiii Stack plugins.

## Plugin Categories

All plugins must belong to one of four categories:

### 1. PIPELINES
CI/CD systems that trigger deployments.

**Responsibilities:**
- Generate workflow files (ultra-thin, only trigger + pass secrets)
- Manage pipeline secrets (SSH keys, API tokens)
- Check runtime prerequisites (Node.js, CLI tools)
- **Control routing** via `canReach()` and `deployStage()` methods
- Orchestrate plugin execution via scan/fix/deploy

**Required Methods:**

```typescript
// STATIC: How can this pipeline reach each stage?
static canReach(stage: Stage, config: FactiiiConfig): Reachability {
  // Returns: { reachable: true, via: 'local' | 'ssh' | 'workflow' }
  // Or:      { reachable: false, reason: 'PROD_SSH not found' }
}

// INSTANCE: Deploy to a stage - handles routing
async deployStage(stage: Stage, options: DeployOptions): Promise<DeployResult> {
  const reach = MyPipeline.canReach(stage, this.config);

  if (!reach.reachable) {
    return { success: false, error: reach.reason };
  }

  if (reach.via === 'ssh') {
    // SSH to server, run CLI there
    await sshExec(envConfig, 'npx stack deploy --staging');
    return { success: true, message: 'Deployed via SSH' };
  }

  // via: 'local' - execute directly
  return this.runLocalDeploy(stage, options);
}
```

**The Four Stages:**

| Stage | Description | Typical Access |
|-------|-------------|----------------|
| `dev` | Local development | Always local |
| `secrets` | Ansible Vault secrets | Always local |
| `staging` | Staging server | SSH key → password fallback → unreachable |
| `prod` | Production server | SSH key → password fallback → unreachable |

**Factiii Pipeline Routing (actual implementation):**

```typescript
static canReach(stage: Stage, config: FactiiiConfig): Reachability {
  switch (stage) {
    case 'dev':
    case 'secrets':
      return { reachable: true, via: 'local' };

    case 'staging':
    case 'prod':
      // On server (in workflow or direct): run locally
      if (process.env.GITHUB_ACTIONS || process.env.FACTIII_ON_SERVER) {
        return { reachable: true, via: 'local' };
      }

      // On dev machine: check for SSH key (~/.ssh/{stage}_deploy_key)
      const sshKey = findSshKeyForStage(stage, config.name);
      if (sshKey) return { reachable: true, via: 'ssh' };

      // Fallback: check vault for {STAGE}_SSH_PASSWORD
      // ... vault password check → returns via: 'ssh' if found

      // AWS environments: allow local provisioning
      // ... AWS config check → returns via: 'local' if found

      // Nothing available
      return { reachable: false, reason: '{STAGE}_SSH not found' };
  }
}
```

### 2. SERVERS (OS Types)
Operating system types that handle OS-specific commands and package management.

**Available OS Types:**
- `mac` — macOS (Homebrew, launchctl)
- `ubuntu` — Ubuntu Linux (apt, systemd)
- `windows` — Windows Server (Chocolatey, Windows Services)
- `amazon-linux` — Amazon Linux 2023 (dnf, systemd)
- `alpine` — Alpine Linux (apk) — for containers

**Server plugins are NOT deployment targets.** They define how to interact with a specific OS. Pipelines handle deployment orchestration.

**Required Static Properties:**
```typescript
static readonly os: ServerOS = 'ubuntu';
static readonly packageManager: PackageManager = 'apt';
static readonly serviceManager: ServiceManager = 'systemd';
```

### 3. FRAMEWORKS
Application frameworks and databases.

**Responsibilities:**
- Detect framework presence
- Run migrations
- Build and prepare applications

### 4. ADDONS
Extensions to frameworks and infrastructure.

**Responsibilities:**
- Configure integrations (auth, payments, storage)
- Validate API keys
- Provide cross-cutting functionality (e.g., server-mode for server hardening)

## Stage Execution

**Environment Variables That Affect Routing:**

| Variable | Purpose |
|----------|---------|
| `GITHUB_ACTIONS` | Set in GitHub Actions. `canReach()` returns `'local'` for all stages. |
| `FACTIII_ON_SERVER` | Set when running on server (non-GitHub). `canReach()` returns `'local'`. |

### How Commands Work

1. User specifies stage: `--dev`, `--secrets`, `--staging`, `--prod` (or no flag = all stages)
2. Command groups all plugin fixes by their `stage` property
3. For each requested stage, asks **pipeline plugin**: `canReach(stage)?`
   - `{ reachable: true, via: 'local' }` → run fixes locally
   - `{ reachable: true, via: 'ssh' }` → SSH to server, run with `--staging` or `--prod`
   - `{ reachable: false, reason: '...' }` → show error, stop

### Commands Are Dumb

- `scan.ts`, `fix.ts`, `deploy.ts` do NOT know about GITHUB_TOKEN, SSH, workflows
- They ONLY ask the pipeline plugin: "can you reach this stage?"
- The **pipeline plugin** decides what's needed (SSH keys, tokens, etc.)

### Command Responsibilities

**init** — First-time vault/secrets setup. Only runs once (or with --force).

**scan** — Read-only issue detection. MUST NOT modify any files. If scan modifies anything, it is a bug.

**fix** — Safe changes only. Creates/updates config files, installs CLI tools, creates workflow files. MUST NOT touch deployment artifacts (docker-compose.yml, nginx configs, containers, SSL certs). If a deployment artifact is broken, fix should say: "Run `npx stack deploy --{stage}` to regenerate"

**deploy** — Modifies deployment artifacts. Runs scan first, blocks on critical issues. Handles: docker build, compose up/down, nginx reload, SSL setup.

### Workflow Pattern (ultra-thin)

Workflows MUST specify `--staging` or `--prod`:

```bash
# Correct
GITHUB_ACTIONS=true npx stack deploy --staging

# WRONG — will try all stages, may trigger more workflows
npx stack fix
```

**Workflows should ONLY:** trigger + pass secrets + SSH to server + run CLI command.

**Workflows should NEVER contain:** server setup, repo cloning, dependency install, build logic, bash >5 lines.

**Exception:** Node.js bootstrap — workflows can check if Node.js exists and install if missing (chicken-and-egg: `npx stack` requires Node.js).

## Stage Batching

All scan/fix operations are batched by stage to minimize SSH overhead.

1. **Collect** — Gather all fixes for requested stages from all plugins
2. **Bundle** — Group fixes by stage (all dev, all staging, all prod)
3. **Execute** — CLI asks pipeline `canReach(stage)` for each stage:
   - `via: 'local'` → run all scans locally in one pass
   - `via: 'ssh'` → SSH once and run with `--staging` or `--prod`
4. **Return** — Results per stage with issue details (not just counts)

### Fix Function Rules

**NEVER in fix scan/fix functions:**
- Check `GITHUB_ACTIONS` or other env vars to determine context
- Call SSH or remote execution
- Assume execution context

**ALWAYS in fix scan/fix functions:**
- Assume running locally on target machine
- Use `execSync` for local commands
- Return boolean (scan: true = issue exists, fix: true = resolved)

## Plugin Structure

### Required Static Properties

```typescript
class MyPlugin {
  static readonly id = 'my-plugin';
  static readonly name = 'My Plugin';
  static readonly category: PluginCategory = 'framework';
  static readonly version = '1.0.0';

  static readonly configSchema: Record<string, unknown> = {};
  static readonly autoConfigSchema: Record<string, string> = {};
  static readonly fixes: Fix[] = [];
  static readonly requiredEnvVars: string[] = [];

  static async shouldLoad(rootDir: string, config: FactiiiConfig): Promise<boolean> {
    return false;
  }
}
```

### File Organization (>1000 lines)

```
src/plugins/{category}/{plugin-name}/
├── index.ts          # Main class, imports everything, exports fixes[]
├── scanfix/          # Scan/fix operations organized by concern
│   ├── docker.ts     # Docker-related fixes
│   ├── node.ts       # Node.js/pnpm fixes
│   └── config.ts     # Configuration checks
├── staging.ts        # Staging-specific operations (only if needed)
├── prod.ts           # Production operations (only if needed)
└── utils/            # Helper functions (only if needed)
```

**Guidelines:**
- `scanfix/` files each export `Fix[]` arrays, combined in `index.ts`
- Environment-specific files only created if they have content
- `index.ts` imports and combines all scanfix arrays: `static readonly fixes = [...dockerFixes, ...nodeFixes]`

### Config Schemas

**configSchema** — User-editable settings merged into `stack.yml`:
```typescript
static readonly configSchema = {
  my_plugin: {
    api_key: 'EXAMPLE-your-api-key',  // EXAMPLE- prefix = required
    timeout: 5000                       // No prefix = optional with default
  }
};
```

**autoConfigSchema** — Auto-detected values for `stackAuto.yml`:
```typescript
static readonly autoConfigSchema = {
  has_my_plugin: 'boolean',
  my_plugin_version: 'string'
};
```

### shouldLoad()

Called during scan/fix/deploy to determine if plugin is relevant:

```typescript
// Pipeline: always load
static async shouldLoad(): Promise<boolean> { return true; }

// Framework: load if detected in package.json
static async shouldLoad(rootDir: string): Promise<boolean> {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return !!deps['my-framework'];
}
```

## Fix Format

```typescript
{
  id: 'missing-env-file',
  stage: 'dev',
  severity: 'warning',
  description: '📋 .env file not found',
  // Optional: os: 'mac' as ServerOS,
  // Optional: targetStage: 'staging',
  scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
    return !fs.existsSync(path.join(rootDir, '.env'));  // true = issue exists
  },
  fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
    fs.copyFileSync(path.join(rootDir, '.env.example'), path.join(rootDir, '.env'));
    return true;  // true = fixed
  },
  manualFix: 'Copy .env.example to .env and fill in values',
}
```

**OS Filtering:** Fixes can specify `os` (string or array) to run only on matching OS types. Pipeline filters based on the target environment's `server` field.

**Severity:**
- `critical` — Blocks deployment (missing config, server unreachable)
- `warning` — Should fix but not blocking (outdated deps, suboptimal config)
- `info` — Informational only (suggestions, best practices)

## Naming Conventions

### Secret & Key Naming

`{STAGE}_{TYPE}` format — stage comes first:

| Secret | Description |
|--------|-------------|
| `STAGING_SSH` | SSH private key for staging (vault) |
| `PROD_SSH` | SSH private key for production (vault) |
| `STAGING_SSH_PASSWORD` | SSH password fallback for staging (vault) |
| `PROD_SSH_PASSWORD` | SSH password fallback for production (vault) |

**On-disk key paths:** `~/.ssh/{stage}_deploy_key` (e.g., `~/.ssh/prod_deploy_key`)

### Config Value Conventions

- Required values: `EXAMPLE-` prefix (e.g., `domain: EXAMPLE-myapp.com`)
- Auto-detected: `OVERRIDE` pattern (user can override auto-detected values)

### Generated Files

All generated files MUST include a version header:
```yaml
# Generated by @factiii/stack v0.1.148
```

## Port Convention

### Slot-Based PORT System

Each repo in a multi-repo setup gets a **slot number** (1-5):

| Slot (PORT=N) | Client Port (300N) | Server Port (500N) |
|---------------|--------------------|--------------------|
| 1             | 3001               | 5001               |
| 2             | 3002               | 5002               |
| 3             | 3003               | 5003               |

**Rules:**
- `.env.example` and `.env` contain `PORT=N` (the slot number, NOT a full port)
- App code derives actual ports: `clientPort = 3000 + PORT`, `serverPort = 5000 + PORT`
- Never hardcode 3001, 5001, etc. — always derive from `PORT`

### IP Detection

For multi-device dev (mobile app → local server):
- `start.sh` auto-detects the machine's local network IP
- Replaces `localhost`/`127.0.0.1` in `.env` with the real IP
- URL variables use `YOUR_IP` as placeholder in `.env.example`

### Protocol Rules

| Stage   | Protocol | Enforcement      |
|---------|----------|------------------|
| dev     | http://  | Scanfix warning  |
| staging | https:// | Scanfix warning  |
| prod    | https:// | Scanfix critical |

## Server-Side Architecture

### Multi-Repo Deployment

Each server runs a single nginx reverse proxy routing to all deployed apps.

### Server Directory Structure

```
~/.factiii/                          # Root infrastructure directory
├── repo-name/                       # Each deployed repo
│   ├── stack.yml                    # Repo config
│   ├── stackAuto.yml               # Auto-detected config
│   ├── .env.staging                 # Secrets (staging server only)
│   └── ... (source code if requiresFullRepo=true)
├── scripts/
│   └── generate-all.ts             # Regenerates merged configs
├── docker-compose.yml               # MERGED from all repos (generated)
└── nginx.conf                       # MERGED from all repos (generated)
```

**Key principle:** Staging and prod are **independent servers**. Each server only has its own environment's secrets.

### requiresFullRepo()

```typescript
static requiresFullRepo(environment: string): boolean {
  // staging → true (build from source)
  // prod → false (pull pre-built images from ECR)
}
```

### Deployment Flows

**Staging (requiresFullRepo = true):**
1. SSH to staging server
2. Clone/pull full repo to `~/.factiii/{repo}/`
3. Write secrets to `.env.staging`
4. Run `generate-all.ts` to regenerate merged configs
5. Build and start: `docker compose up -d {repo}-staging`

**Production (requiresFullRepo = false):**
1. SSH to production server
2. Create `~/.factiii/{repo}/` with just `stack.yml`
3. Write secrets to `.env.prod`
4. Run `generate-all.ts` to regenerate merged configs
5. Pull image from ECR and start: `docker compose up -d {repo}-prod`

### Docker Compose Modifications

After `generate-all.ts`, pipeline plugins can modify compose for:
- **Environment-specific services** (postgres for staging, not prod which uses RDS)
- **Image references** (ECR paths for production)

## Best Practices

1. **Single Responsibility** — Each plugin handles one domain
2. **Idempotent Operations** — Fixes and deployments safe to run multiple times
3. **Clear Error Messages** — Always provide actionable `manualFix` instructions
4. **Fail Fast** — Validate configuration in scan phase, not during deployment
5. **Test Locally** — All deployment logic testable via `npx stack deploy --dev`
6. **YAML String Building** — Use string concat (`'key: ' + var`), NOT template literals (breaks YAML indentation)
