# Core Workflow: Check → Fix → Deploy

Core follows a **2-stage process** to ensure seamless setup and deployment.

## Stage 1: Check (`npx core init`)

**Purpose:** Discover all issues across all environments without making changes.

### What It Checks

**Local Environment:**
- ✅ Project structure (Next.js, Expo, tRPC, Prisma)
- ✅ Configuration files (`core.yml`, `coreAuto.yml`)
- ✅ Environment files (`.env.example`, `.env.staging`, `.env.prod`)
- ✅ Package.json scripts
- ✅ Dependencies installed
- ✅ Gitignore configuration

**GitHub:**
- ✅ Workflow files exist
- ✅ Required secrets configured (`STAGING_ENVS`, `PROD_ENVS`, SSH keys, AWS credentials)
- ✅ Repository permissions

**Remote Servers (via SSH):**
- ✅ SSH connection working
- ✅ Infrastructure directories exist
- ✅ Server configurations match local
- ✅ Deployed repos discovered

### Output

After checking everything, `init` provides a **comprehensive report**:

```
============================================================
📊 Summary:
   ✅ 6 checks passed
   ⚠️  2 items need attention
   ❌ 3 critical issues

📝 Issues Found:
   1. ❌ Missing GitHub secret: PROD_ENVS
   2. ❌ SSH connection failed: prod server
   3. ⚠️  .env.staging not gitignored
============================================================
```

**Key principle:** Find **ALL** issues before attempting any fixes. This prevents:
- Fixing issues out of order
- Partial fixes that cause new problems
- Confusion about what still needs fixing

---

## Stage 2: Fix (`npx core init fix`)

**Purpose:** Fix everything in logical order to ensure each fix enables the next.

### Fix Order (Dependency Chain)

The fixes happen in a specific order because later fixes depend on earlier ones:

```
1. Local Environment
   ↓ (must be correct before uploading)
2. GitHub Secrets  
   ↓ (must exist before server checks)
3. Remote Servers
   ↓ (must be set up before deployment)
4. Verification Workflow
```

### 1. Local Environment Fixes

**What:**
- Generate missing config files
- Install missing dependencies
- Fix package.json scripts
- Update .gitignore
- Create .env templates

**Why first:** Local configs must be correct before uploading to GitHub or servers.

### 2. GitHub Secrets Upload

**What:**
- Upload `STAGING_ENVS` from `.env.staging`
- Upload `PROD_ENVS` from `.env.prod`
- Verify all required secrets exist

**Why second:** Secrets must exist in GitHub before:
- Workflows can run
- Server deployments can access environment variables

**Note:** This is why `.env.prod` must be gitignored - secrets are uploaded via API, never committed.

### 3. Remote Server Setup

**What:**
- SSH to staging/prod servers
- Create infrastructure directories
- Fix file permissions
- Generate server configs
- Validate configurations

**Why third:** Servers can only be set up after:
- SSH secrets exist in GitHub (from step 2)
- Local configs are correct (from step 1)

### 4. Verification

**What:**
- Triggers `core-init.yml` workflow with `fix=true`
- Runs all checks again
- Confirms everything is working

**Why last:** Final verification that all previous fixes worked.

### Output

```
🔧 Fixing environment: jsnyder10/factiii

Stage 1: Local Environment
   ✅ Generated coreAuto.yml
   ✅ Updated .gitignore
   ✅ All local configs ready

Stage 2: GitHub Secrets
   📤 Uploading STAGING_ENVS...
   ✅ STAGING_ENVS uploaded (36 variables)
   📤 Uploading PROD_ENVS...
   ✅ PROD_ENVS uploaded (36 variables)

Stage 3: Remote Servers
   🔌 Connecting to staging server...
   ✅ SSH connection successful
   📁 Setting up infrastructure...
   ✅ Directories created
   ✅ Permissions fixed
   
   🔌 Connecting to prod server...
   ✅ SSH connection successful
   ✅ Infrastructure ready

Stage 4: Verification
   🚀 Triggering verification workflow...
   ✅ All checks passed!

✨ Init fix completed!
   Everything is ready for deployment.
   Run: npx core deploy
```

---

## Stage 3: Deploy (`npx core deploy`)

**Purpose:** Deploy containers to staging/production.

### What It Does

1. **Pre-deployment check:** Runs `init` (not `init fix`) to verify readiness
2. **Blocks if:** Critical issues found (EXAMPLE- values, missing secrets, SSH failures)
3. **Warns if:** Non-critical issues (env var changes, domain updates with overrides)
4. **Deploys:** Triggers GitHub Actions to build and deploy containers

### Flow

```
npx core deploy
   ↓
Run init check
   ↓
├─ Critical issues? → STOP, show errors
├─ Warnings? → WARN, continue
└─ All good? → Deploy
   ↓
Trigger core-deploy.yml workflow
   ↓
Build → Test → Deploy → Migrations
```

---

## Why This 2-Stage Process?

### Problem: Single-stage approaches fail

**Without separation:**
- Fix issue 1 → fails because issue 2 isn't fixed yet
- Fix issue 2 → breaks issue 1
- Developer confused about state
- Hard to debug what went wrong

### Solution: Check everything first, then fix in order

**With 2-stage:**
1. **Check:** See ALL issues at once
2. **Fix:** Resolve them in dependency order
3. **Result:** Each fix succeeds because dependencies are already fixed

### Example

**Bad (single-stage):**
```
Trying to upload secrets... ❌ SSH not configured
Configuring SSH... ❌ Local config invalid
Fixing local config... ❌ GitHub workflows missing
...endless loop of failures...
```

**Good (2-stage):**
```
Check:
   ❌ GitHub workflows missing
   ❌ Local config invalid  
   ❌ SSH not configured
   ❌ Secrets not uploaded

Fix (in order):
   ✅ Generate workflows (local)
   ✅ Fix local config (local)
   ✅ Upload secrets (GitHub) ← now possible
   ✅ Configure SSH (servers) ← now possible
```

---

## Commands Summary

| Command | Stage | Purpose | Makes Changes? |
|---------|-------|---------|----------------|
| `npx core init` | Check | Find ALL issues | Local only |
| `npx core init fix` | Fix | Fix ALL issues in order | Local + GitHub + Servers |
| `npx core deploy` | Deploy | Deploy containers | Deployment only |

**Best Practice:**
1. Run `init` to see what's broken
2. Manually fix any complex issues (like editing core.yml)
3. Run `init fix` to automate the rest
4. Run `deploy` to deploy

---

## Automation is Key

The goal is **seamless** setup:

1. Developer runs `init` → sees comprehensive report
2. Developer fixes manual things (edits core.yml, creates .env files)
3. Developer runs `init fix` → everything else happens automatically
4. Developer runs `deploy` → deployed

**No back-and-forth.** No confusion. Just works.

