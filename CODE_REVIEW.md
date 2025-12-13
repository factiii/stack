# Code Review: Alignment with New Architecture

This document identifies gaps between the current code and the new architecture defined in STANDARDS.md.

---

## src/cli/init.js

### Current Behavior vs Target Spec

| Feature | Target Spec | Current Code | Status |
|---------|-------------|--------------|--------|
| Detect EXAMPLE- prefix | Block on `EXAMPLE-` values | Uses `yourdomain.com`, `123456789`, `your-repo-name` | ⚠️ NEEDS UPDATE |
| Generate coreAuto.yml | Auto-detect and write coreAuto.yml | Does not generate coreAuto.yml | ❌ MISSING |
| OVERRIDE pattern | Parse `value OVERRIDE newValue` | Not implemented | ❌ MISSING |
| Stack detection | Detect Next.js, Expo, tRPC, Prisma | Only detects Prisma | ⚠️ PARTIAL |
| Local auto-fix | Can modify local files freely | ✅ Creates/updates core.yml, workflows | ✅ ALIGNED |
| Remote check-only | SSH read-only, no modifications | Triggers GitHub workflow (read-only) | ✅ ALIGNED |
| No validate command | init does all validation | Separate validate.js exists | ⚠️ LEGACY |

### Specific Gaps

#### 1. Placeholder Detection (Line 32-54)
**Current:** Checks for `your-repo-name`, `yourdomain.com`, `123456789`
**Target:** Check for `EXAMPLE-` prefix pattern

```javascript
// Current (lines 32-54)
if (config.name === 'your-repo-name') { ... }
if (envConfig.domain.includes('yourdomain.com')) { ... }

// Target
if (config.name?.startsWith('EXAMPLE-')) { ... }
if (config.ssl_email?.startsWith('EXAMPLE-')) { ... }
```

#### 2. Missing coreAuto.yml Generation
**Current:** Prisma detection appends to core.yml (lines 791-815)
**Target:** Should generate separate coreAuto.yml with all auto-detected values

```javascript
// Missing functionality
function generateCoreAutoYml(rootDir) {
  const detected = {
    has_nextjs: detectNextJs(rootDir),
    has_expo: detectExpo(rootDir),
    has_trpc: detectTrpc(rootDir),
    has_prisma: detectPrisma(rootDir),
    prisma_schema: findPrismaSchema(rootDir),
    prisma_version: detectPrismaVersion(rootDir),
    dockerfile: findDockerfile(rootDir),
    package_manager: detectPackageManager(rootDir),
    // ...
  };
  fs.writeFileSync('coreAuto.yml', yaml.dump(detected));
}
```

#### 3. Missing Stack Detection
**Current:** Only detects Prisma
**Target:** Detect all T3 stack components

Missing detection functions:
- `detectNextJs()` - Check for next.config.js, @next packages
- `detectExpo()` - Check for app.json, expo packages
- `detectTrpc()` - Check for @trpc packages
- `detectPackageManager()` - Check for pnpm-lock.yaml, yarn.lock, package-lock.json

#### 4. Missing OVERRIDE Pattern Support
**Target:** Parse `detected_value OVERRIDE custom_value` in coreAuto.yml

```javascript
// Missing functionality
function parseOverride(value) {
  if (typeof value === 'string' && value.includes(' OVERRIDE ')) {
    const [detected, custom] = value.split(' OVERRIDE ');
    return { detected, custom, hasOverride: true };
  }
  return { detected: value, custom: null, hasOverride: false };
}
```

#### 5. Drift Detection Warning System
**Target:** Warn when auto-detected != deployed != override

```javascript
// Missing functionality
function checkForDrift(detected, deployed, override) {
  if (override && detected !== override) {
    console.log(`⚠️ Override in effect: ${detected} → ${override}`);
  }
  if (deployed && detected !== deployed && !override) {
    console.log(`❌ Unexpected drift: deployed=${deployed}, detected=${detected}`);
  }
}
```

### What's Working Well

- ✅ Local file creation/modification (core.yml, workflows)
- ✅ Prisma schema detection with monorepo support
- ✅ Prisma version detection
- ✅ Git branch checking
- ✅ Environment file validation
- ✅ Comprehensive audit report
- ✅ Workflow generation
- ✅ GitHub workflow triggering (optional)

---

## src/cli/deploy.js

### Current Behavior vs Target Spec

| Feature | Target Spec | Current Code | Status |
|---------|-------------|--------------|--------|
| Run init first | Run init check before deploy | Runs validate.js (line 45) | ⚠️ PARTIAL |
| Blocking failures | Stop on critical issues | Exits on validation failure | ✅ ALIGNED |
| Non-blocking failures | Warn but proceed | Not implemented | ❌ MISSING |
| Merge core.yml + coreAuto.yml | Use both config files | Only uses core.yml (line 52) | ❌ MISSING |
| EXAMPLE- detection | Block on EXAMPLE- values | Uses validate.js patterns | ⚠️ NEEDS UPDATE |

### Specific Gaps

#### 1. Uses validate.js Instead of init (Line 45)
**Current:** Calls separate `validate()` function
**Target:** Should call `init()` to leverage full validation + auto-fix

```javascript
// Current (line 45)
validate({ config: configPath });

// Target
const initResult = await init({ noRemote: true }); // Run init without remote trigger
if (initResult.hasBlockingErrors) {
  console.error('❌ Blocking errors found. Run: npx core init fix');
  process.exit(1);
}
```

#### 2. No Distinction Between Blocking vs Non-Blocking (Lines 44-49)
**Current:** Any validation error stops deployment
**Target:** Distinguish between blocking and non-blocking failures

```javascript
// Missing functionality
function categorizeFailures(errors) {
  const blocking = [];
  const nonBlocking = [];
  
  for (const error of errors) {
    if (error.type === 'env_change' || error.type === 'domain_update') {
      nonBlocking.push(error);
    } else {
      blocking.push(error);
    }
  }
  
  return { blocking, nonBlocking };
}
```

#### 3. No coreAuto.yml Integration (Line 52)
**Current:** Only loads core.yml
**Target:** Merge core.yml + coreAuto.yml with override resolution

```javascript
// Current (line 52)
const config = yaml.load(fs.readFileSync(configPath, 'utf8'));

// Target
const coreConfig = yaml.load(fs.readFileSync('core.yml', 'utf8'));
const autoConfig = yaml.load(fs.readFileSync('coreAuto.yml', 'utf8'));
const config = mergeConfigs(coreConfig, autoConfig);
```

#### 4. No init fix Suggestion on Failure
**Current:** Generic error message (line 47)
**Target:** Suggest `npx core init fix` for resolution

```javascript
// Current (line 47-48)
console.error('❌ Config validation failed. Fix errors before deploying.\n');

// Target
console.error('❌ Deployment blocked: [specific error]');
console.error('   Run: npx core init fix');
```

### What's Working Well

- ✅ Validates config before deployment
- ✅ Checks workflow files exist
- ✅ GitHub token validation
- ✅ Triggers workflow via GitHub API
- ✅ Polls for workflow completion
- ✅ Reports success/failure status
- ✅ Timeout handling

---

## src/cli/validate.js

### Status: LEGACY - Consider Deprecation

**Reason:** Per new spec, `init` handles all validation. Separate `validate` command is redundant.

**Current Functionality:**
- Checks for required fields (name, environments)
- Validates domain presence per environment
- Validates port ranges
- Warns about missing ssl_email, ecr_registry, ecr_repository

**Gap:** Does NOT check for `EXAMPLE-` prefix pattern (uses old placeholder detection).

**Action:** 
1. Keep for now (deploy.js depends on it)
2. Eventually merge into init.js
3. Redirect `npx core validate` to `npx core init` with deprecation warning

---

## src/cli/check-config.js

### Status: REVIEW - Possible Overlap with init fix

**Current Functionality:**
- SSHs to staging/prod servers
- Lists config files on server
- Validates each config
- Copies generators and scripts to server
- Regenerates docker-compose.yml and nginx.conf
- Checks service status

**Gap Analysis:**
- Does SSH and MODIFIES remote servers (copies files, regenerates configs)
- This behavior should belong to `init fix`, not `init`
- Current `init` doesn't SSH at all (just triggers workflow)

**Action:**
- Consider refactoring into `init-fix.js` for remote environment setup
- Keep as separate command until `init fix` is implemented

---

## Legacy Files Summary

| File | Status | Action | Notes |
|------|--------|--------|-------|
| `src/cli/validate.js` | Legacy | Deprecate | Merge into init |
| `src/cli/check-config.js` | Keep | Refactor | Move logic to init-fix |
| `src/cli/undeploy.js` | Keep | None | Still needed for cleanup |
| `src/cli/generate-workflows.js` | Keep | None | Still needed |
| `bin/core` | Keep | Update | Remove validate command |

---

## scripts/ Directory

### Status: LEGACY - Mixed Usage

| File | Status | Notes |
|------|--------|-------|
| `backup-all-dbs.sh` | Keep | Utility script |
| `generate-all.js` | Review | May duplicate generator functionality |
| `generate-certbot-domains.sh` | Keep | SSL certificate utility |
| `generate-nginx-config.sh` | Review | Duplicates src/generators/generate-nginx.js? |
| `generate-workflow.js` | Review | Duplicates src/cli/generate-workflows.js? |
| `parse-infrastructure-config.sh` | Legacy | Old centralized config approach |
| `setup-infrastructure.sh` | Review | May be needed for server setup |

### Recommended Actions:
1. Review `generate-*.sh` scripts for duplication with Node.js generators
2. Mark `parse-infrastructure-config.sh` for removal (legacy centralized approach)
3. Keep utility scripts (backup, certbot)

---

## src/generators/ Directory

### Status: KEEP - Core Functionality

| File | Status | Notes |
|------|--------|-------|
| `generate-compose.js` | Keep | Docker Compose generation |
| `generate-nginx.js` | Keep | Nginx config generation |
| `merge-configs.js` | Keep | Multi-repo config merging |

**Missing:**
- `generate-core-auto.js` - Needed for coreAuto.yml generation

---

## bin/core (CLI Entry Point)

### Current Commands vs Target Spec

| Command | Current | Target | Status |
|---------|---------|--------|--------|
| `init` | ✅ Exists | Keep | ✅ |
| `init fix` | ❌ Missing | Add | ❌ MISSING |
| `validate` | ✅ Exists | Remove/Deprecate | ⚠️ LEGACY |
| `check-config` | ✅ Exists | Merge into init fix | ⚠️ REFACTOR |
| `deploy` | ✅ Exists | Keep | ✅ |
| `undeploy` | ✅ Exists | Keep | ✅ |
| `generate-workflows` | ✅ Exists | Keep | ✅ |

### Recommended Changes:

1. **Add `init fix` subcommand** (line 27):
```javascript
program
  .command('init fix')
  .description('Fix all environments including remote servers')
  .option('--dry-run', 'Preview changes without applying')
  .action(async (options) => {
    await initFix(options);
  });
```

2. **Deprecate `validate` command** (lines 29-35):
```javascript
program
  .command('validate')
  .description('[DEPRECATED] Use "init" instead')
  .action(() => {
    console.log('⚠️  "validate" is deprecated. Use "npx core init" instead.');
    init({ noRemote: true });
  });
```

3. **Consider renaming `check-config`** to clarify it modifies remote servers

---

## Priority Actions (Future Work)

### High Priority
1. Add `EXAMPLE-` prefix detection to replace current placeholder checks
2. Create `generate-core-auto.js` for coreAuto.yml generation
3. Add Next.js, Expo, tRPC detection alongside existing Prisma detection

### Medium Priority
4. Implement OVERRIDE pattern parsing
5. Add drift detection warning system
6. Update deploy.js to merge core.yml + coreAuto.yml

### Low Priority
7. Deprecate validate.js (redirect to init)
8. Review check-config.js for overlap

---

## Notes

This review is documentation only. No code changes were made.
The existing code continues to work but doesn't fully implement the new architecture.
Changes should be made incrementally to avoid breaking existing functionality.

