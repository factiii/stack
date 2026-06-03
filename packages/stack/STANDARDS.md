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
// STATIC: Can this pipeline reach a stage from the dev machine?
//
// Under the dev-direct architecture, every command runs on dev.
// canReach() returns local-or-unreachable; the legacy 'ssh' / 'workflow'
// routing values no longer exist.
static canReach(stage: Stage, config: FactiiiConfig): Reachability {
  // Returns: { reachable: true, via: 'local' }
  // Or:      { reachable: false, reason: '...' }
}

// INSTANCE: Deploy to a stage. The CLI runs runStageChain first (in
// fix mode) and only invokes this when prereqs are clean.
async deployStage(stage: Stage, options: DeployOptions): Promise<DeployResult> {
  return this.runLocalDeploy(stage, options);
}
```

**The Three Stages:**

| Stage | Description |
|-------|-------------|
| `dev` | Dev machine. All scanfixes run here, including ones that touch the vault or write SSH keys. |
| `staging` | Staging server. Scanfixes run from dev; remote commands route via `serverExec` over the SSH tunnel. |
| `prod` | Production server. Same as staging. |

Note: the legacy `secrets` stage is folded into `dev`. Vault unlocking, key extraction, and `.env` writing are now `stage: 'dev'` fixes ordered with `requires` chains.

**Factiii Pipeline Routing (actual implementation):**

```typescript
static canReach(stage: Stage, config: FactiiiConfig): Reachability {
  switch (stage) {
    case 'dev':
      return { reachable: true, via: 'local' };

    case 'staging':
    case 'prod': {
      const envs = getEnvironmentsForStage(config, stage);
      const allExample = Object.values(envs).every(
        (e) => !e.domain || e.domain.toUpperCase().startsWith('EXAMPLE'),
      );
      const hasAws = Object.values(envs).some((e) => !!e.config || !!e.access_key_id);
      if (allExample && !hasAws) {
        return { reachable: false, reason: stage + ' domain is still a placeholder' };
      }
      return { reachable: true, via: 'local' };
    }
  }
}
```

(No SSH-key probing, no GITHUB_TOKEN fallback — the tunnel itself is opened by `runStageChain` on stage entry, and the SSH key is fetched lazily via `findSshKeyForStage`.)

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

### How Commands Work

1. User specifies stage: `--dev`, `--staging`, `--prod` (or no flag = all stages).
2. The command (scan/fix/deploy) collects all plugin fixes.
3. The command calls `runStageChain(fixes, { stages, applyFixes, ... })`.
4. The chain runs each stage as a DAG. For staging/prod it opens an SSH tunnel before the DAG and closes it after.
5. Per-fix outcomes (`ok`/`fixed`/`failed`/`skipped`/`manual`) are returned as a `StageChainResult` and rendered as the end-of-run summary.

### The serverExec Contract

When a scanfix's `scan` or `fix` function needs to issue a shell command, it calls `serverExec(stage, cmd)`:

- `stage === 'dev'` → local `execSync`.
- `stage === 'staging' | 'prod'` → `tunnelExec` over the cached per-stage SSH tunnel that `runStageChain` opened on stage entry.

Returns trimmed stdout. Throws on non-zero exit. Scanfix authors do not call `tunnelExec` or `execSync` directly.

### Scanfix Authoring Rules

- **`scan` returns `true` for "issue detected."** Throw only for genuine surprises (filesystem error, malformed config the scan reasonably expected to be valid).
- **`fix` returns `true` if it resolved the issue, `false` if it could not.** Do not catch errors and return `true` to silence them — let them propagate.
- **Use `serverExec(stage, cmd)` for all shell commands.** Never call `execSync` directly when you mean "run this on the target stage."
- **Order with `requires`.** Within a stage, list prereq fix ids in `requires`. The DAG runner topo-sorts and skip-cascades on prereq failure.
- **Use `os` to filter by target server type.** Cross-OS scanfixes either declare `os: ['mac', 'ubuntu']` and write commands that work on both, or duplicate per-OS with single-OS `os` filters.
- **Never `process.exit` inside scan or fix.** Return false or throw.
- **Never check `process.env.GITHUB_ACTIONS` or `FACTIII_ON_SERVER` inside scan or fix.** Scanfixes always run on the dev machine.

### Command Responsibilities

**init** — First-time vault/secrets setup. Only runs once (or with --force).

**scan** — Read-only issue detection. MUST NOT modify any files. If scan modifies anything, it is a bug.

**fix** — Safe changes only. Creates/updates config files, installs CLI tools, creates workflow files. MUST NOT touch deployment artifacts (docker-compose.yml, nginx configs, containers, SSL certs). If a deployment artifact is broken, fix should say: "Run `npx stack deploy --{stage}` to regenerate"

**deploy** — Modifies deployment artifacts. Runs the upstream-stage fix chain first (see Deploy Prereq Policy below), then touches deployment artifacts: docker build, compose up/down, nginx reload, SSL setup.

### Deploy Prereq Policy

`npx stack deploy --<stage>` runs the upstream-stage fix chain before touching any deployment artifact:

- `deploy --staging` runs `runStageChain(['dev'], applyFixes: true)` first.
- `deploy --prod` runs `runStageChain(['dev', 'staging'], applyFixes: true)` first. The `staging` step opens an SSH tunnel to the staging server and applies any pending staging fixes end-to-end before prod artifacts are touched.

If a prereq stage breaks — a fix fails, a critical issue goes unfixed, or the SSH tunnel cannot open — deploy aborts with `Prereq stage broken (<stage>). Fix and retry.` before `deployStage` is called.

Two operational consequences:

1. **Deploy is no longer read-only before the deploy step.** The prereq pass mutates dev-machine state idempotently (`.env.example` regeneration, vault-key extraction, SSH-key-to-disk, etc.) — the same mutations `npx stack fix` would apply.
2. **Deploying to prod requires staging to be reachable.** If the staging server is down or the SSH key is missing, `deploy --prod` aborts without touching prod.

Escape hatch: run `npx stack fix --staging` to resolve staging state manually, then retry `deploy --prod`.

### Host-Machine Fixes (Opt-In)

A normal scanfix touches **project state** (files inside `rootDir`, the
configured server, the configured cloud account). Some fixes need to touch
**developer-personal state** instead — files under the user's home directory
that aren't part of the repo and aren't owned by the project. The current
example is `~/.claude/skills/` (per-user Claude Code skills), but the same
rule applies to anything under `~/.config/`, `~/.ssh/` (beyond the
documented `{stage}_deploy_key` convention), shell rc files, or system
package state.

**Rule:** Any scanfix that writes to the developer's home directory outside
the project root MUST be gated behind an explicit opt-in flag in
`stack.local.yml`. The default must be off.

**Why:** `stack.local.yml` is the per-developer config file by design.
Silently dropping files in `~/.claude/` or `~/.ssh/` on every `npx stack fix`
is more invasive than the rest of the scanfix surface, surprises devs who
curate their own home dir, and breaks consent for users who don't even use
the tool the fix is configuring (e.g., a dev who doesn't use Claude Code).
Gating on `stack.local.yml` keeps CI and headless runs unaffected, makes the
choice visible in the per-dev config file, and lets devs revert by flipping
one line.

**How to apply:**

1. Add a typed boolean field to `LocalConfig` in `src/utils/config-helpers.ts`
   (e.g. `claude_skills?: boolean`). Document the default and link back to
   this section in a comment.
2. In the scanfix, call `loadLocalConfig(rootDir)` and early-return from both
   `scan` (return `false` — no issue) and `fix` (return `true` — no-op) when
   the flag is unset or false. Re-check the flag in `fix` even if `scan`
   already gated; never assume scan ran first.
3. Mention the opt-in flag in the fix `description` and `manualFix` so the
   path to enabling it is obvious from the scan output.
4. Update `src/cli/init.ts` to write the opt-in as a *commented-out* stub in
   newly created `stack.local.yml` files, with a comment block explaining
   what it does, why it's off by default, and how to turn it on. For
   pre-existing `stack.local.yml` files, append the same stub if the flag
   name is not already present — never flip a value the user has set.
5. The fix must remain idempotent and non-destructive even when enabled:
   never overwrite a file the user has hand-edited. Document the refresh
   path (typically: delete the file and re-run the fix).

**Current host-machine fixes:**
- `prod-check-skill-installed` (factiii pipeline) — installs the prod-check
  Claude Code skill. Gated on `claude_skills: true` in `stack.local.yml`.

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

**Workflow files** use a separate `WORKFLOW_VERSION` constant (in `src/plugins/pipelines/factiii/utils/workflows.ts`) instead of the package version. This prevents every `@factiii/stack` release from triggering "outdated workflows" in consuming repos. Only bump `WORKFLOW_VERSION` when the workflow templates actually change.

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

## AWS Account Separation

Two IAM users per project, one per AWS account:

| Account | IAM User | Environments | S3 Bucket | ECR |
|---------|----------|-------------|-----------|-----|
| Dev | `factiii-{project}-dev` | dev + staging | `factiii-{project}-dev` | `factiii-{project}-dev` |
| Prod | `factiii-{project}-prod` | prod only | `factiii-{project}` | `factiii-{project}` |

- All AWS resources tagged with `factiii:project = {project-name}`
- Dev account handles both local development and staging infrastructure
- Prod account is isolated for production security
- AWS credentials stored in `~/.aws/credentials` with named profiles

## Best Practices

1. **Single Responsibility** — Each plugin handles one domain
2. **Idempotent Operations** — Fixes and deployments safe to run multiple times
3. **Clear Error Messages** — Always provide actionable `manualFix` instructions
4. **Fail Fast** — Validate configuration in scan phase, not during deployment
5. **Test Locally** — All deployment logic testable via `npx stack deploy --dev`
6. **YAML String Building** — Use string concat (`'key: ' + var`), NOT template literals (breaks YAML indentation)
