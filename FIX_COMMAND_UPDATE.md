# Fix Command Update - Alignment with Scan/Deploy Pattern

## Summary

Updated `npx factiii fix` to align with `scan` and `deploy` commands by triggering GitHub Actions workflows for remote stages (staging/prod) instead of trying to fix them locally.

## Changes Made

### 1. Updated `src/cli/fix.ts`

**Before:**
- Always ran fixes locally
- Called `scan()` with `silent: true` (suppressed workflow triggers)
- Could not reach staging/prod servers (no SSH keys on dev machine)

**After:**
- Checks reachability for each stage using pipeline plugin's `canReach()`
- Runs fixes locally for directly reachable stages (dev, secrets)
- Triggers GitHub Actions workflows for remote stages (staging, prod)
- Respects `--on-server` flag to run directly when already on target server

### 2. Created Fix Workflows

Added two new workflow files:
- `src/plugins/pipelines/factiii/workflows/factiii-fix-staging.yml`
- `src/plugins/pipelines/factiii/workflows/factiii-fix-prod.yml`

These workflows:
- SSH to the target server
- Run `npx factiii fix --on-server --staging` (or `--prod`)
- Only fix the specific stage (not dev/secrets)

### 3. Updated Workflow Generator

Modified `src/plugins/pipelines/factiii/index.ts` to include fix workflows in the generation list.

### 4. Fixed GitHub Workflow Monitor

Updated `src/utils/github-workflow-monitor.ts` to make workflow inputs optional:
- Scan/fix workflows don't accept inputs (stage-specific by filename)
- Deploy workflow accepts `environment` input
- Prevents "HTTP 422: Unexpected inputs" errors

## Architecture Alignment

All three commands now follow the same pattern:

| Command | Local (dev/secrets) | Remote (staging/prod) |
|---------|--------------------|-----------------------|
| `npx factiii scan` | Runs locally | Triggers `factiii-scan-{stage}.yml` |
| `npx factiii fix` | Runs locally | Triggers `factiii-fix-{stage}.yml` |
| `npx factiii deploy` | Runs locally | Triggers `factiii-deploy.yml` |

## Key Features

### 1. Stage-Specific Execution

When workflows SSH to staging/prod, they use the `--on-server` flag:

```bash
npx factiii fix --on-server --staging
```

This ensures:
- Only the specified stage is fixed (not dev/secrets)
- No recursive SSH attempts (already on target server)
- Correct environment context

### 2. Reachability Checks

The fix command uses the pipeline plugin's `canReach()` method to determine:
- `via: 'local'` → Run fixes directly
- `via: 'workflow'` → Trigger GitHub Actions workflow
- `reachable: false` → Show error with reason

### 3. --on-server Flag Protection

Critical protection comments added to prevent recursive SSH:

```typescript
// ============================================================
// CRITICAL: --on-server flag bypasses canReach checks
// ============================================================
// Why this exists: When workflows SSH to staging/prod and run commands,
// we're already on the target server. canReach() would try to SSH again
// causing connection loops and failures.
// What breaks if changed: Fix from staging/prod server tries to SSH
// back to itself, causing "Connection refused" or infinite loops.
// Dependencies: Workflows MUST use --on-server flag when running commands
// on staging/prod servers.
// ============================================================
```

## Usage Examples

### Fix Dev Environment (Local)
```bash
npx factiii fix --dev
```
Runs fixes locally on dev machine.

### Fix Staging (Triggers Workflow)
```bash
npx factiii fix --staging
```
Output:
```
🔧 Running auto-fixes...

🔄 Triggering remote fixes via GitHub Actions...

   Triggering staging fix...
   ✅ staging fix triggered: https://github.com/user/repo/actions/runs/123

💡 View fix results in GitHub Actions
```

### Fix All Stages
```bash
npx factiii fix
```
- Fixes dev/secrets locally
- Triggers workflows for staging/prod

### Fix on Server (Called by Workflow)
```bash
npx factiii fix --on-server --staging
```
Runs directly on staging server (bypasses canReach checks).

## Testing

Tested in the factiii application repository:

1. ✅ Link the local package:
   ```bash
   cd /path/to/app
   pnpm link /Users/jon/infrastructure
   ```

2. ✅ Generate workflows:
   ```bash
   npx factiii generate-workflows
   # ✅ Generated factiii-fix-staging.yml
   # ✅ Generated factiii-fix-prod.yml
   ```

3. ✅ Test fix command:
   ```bash
   npx factiii fix --staging
   # 🔧 Running auto-fixes...
   # 🔄 Triggering remote fixes via GitHub Actions...
   #    Triggering staging fix...
   #    ✅ staging fix triggered: https://github.com/factiii/actions/runs/20353362912
   ```

4. ✅ Verify workflow execution:
   ```bash
   gh run list --limit 5
   # completed	success	Factiii Fix Staging	...
   ```

5. ✅ Verify workflow ran on server:
   - SSHed to api-staging.factiii.com
   - Ran `npx factiii fix --on-server --staging`
   - Fixed 1 issue (stopped unmanaged containers)
   - Only operated on staging stage

## Workflow Files Generated

Running `npx factiii generate-workflows` now generates:

1. `factiii-deploy.yml` - Manual deployment
2. `factiii-staging.yml` - Auto-deploy on push to main
3. `factiii-production.yml` - Auto-deploy on merge to production
4. `factiii-undeploy.yml` - Manual cleanup
5. `factiii-scan-staging.yml` - Scan staging server ✨
6. `factiii-scan-prod.yml` - Scan production server ✨
7. `factiii-fix-staging.yml` - Fix staging server ✨ NEW
8. `factiii-fix-prod.yml` - Fix production server ✨ NEW
9. `factiii-dev-sync.yml` - Dev sync for testing

## Benefits

1. **Consistency** - All commands (scan/fix/deploy) work the same way
2. **Security** - No need for SSH keys on dev machines
3. **Clarity** - Clear separation between local and remote operations
4. **Maintainability** - Single pattern to understand and maintain
5. **Flexibility** - Can fix specific stages without affecting others

## Notes

- Docker containers on staging/prod are NOT stopped during fix operations
- Fixes run in the context of the deployed application
- Only auto-fixable issues are fixed; manual issues are reported
- Workflows require `STAGING_SSH` and `PROD_SSH` secrets in GitHub

