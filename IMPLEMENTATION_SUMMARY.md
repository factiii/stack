# Stage Batching Implementation Summary

## Completed

### 1. Documentation Updates
✅ Added Stage Batching Architecture section to STANDARDS.md
✅ Added Stage Batching (CRITICAL) section to .cursorrules
✅ Added critical SSH architecture comments to:
   - src/plugins/pipelines/factiii/index.ts (canReach method)
   - src/plugins/servers/mac-mini/index.ts (fix functions)
   - src/cli/scan.ts (--on-server flag)
   - src/cli/fix.ts (--on-server flag)

### 2. Fix Command Updates
✅ Updated fix.ts to trigger workflows for remote stages
✅ Added per-stage result display (dev/secrets/staging/prod breakdown)
✅ Fix command exits with error code 1 when fixes fail
✅ Created factiii-fix-staging.yml and factiii-fix-prod.yml workflows

### 3. Server Plugin Simplification
✅ Removed isOnServer checks from individual fix functions:
   - staging-docker-missing (scan + fix)
   - staging-docker-not-running (scan + fix)
   - staging-docker-autostart (scan + fix)
   - staging-node-missing (scan + fix)
   - staging-git-missing (scan + fix)
   - staging-pnpm-missing (scan + fix)
   - staging-repo-not-cloned (scan)

✅ All fix functions now assume running locally
✅ Added "Executed locally - SSH handled by CLI wrapper" comments

### 4. Workflow Monitor Updates
✅ Made workflow inputs optional (scan/fix don't need inputs)
✅ Only deploy workflow uses environment input

## Critical Architecture Points (Now Documented)

### SSH Keys Location
**SSH keys (STAGING_SSH, PROD_SSH) are ONLY in GitHub Secrets.**
- Dev machine does NOT have these keys
- Dev machine CANNOT SSH to staging/prod
- All staging/prod operations MUST trigger workflows
- Workflows have access to secrets, SSH once, run with --on-server

### Stage Batching
- Scan collects ALL fixes for a stage
- CLI checks --on-server ONCE per stage
- Workflows SSH ONCE per stage
- Individual fix functions run locally (no SSH, no isOnServer checks)

### Result Format
Clean per-stage breakdown:
```
RESULTS BY STAGE

DEV:
   Fixed: 2, Manual: 0, Failed: 0

STAGING:
   Fixed: 0, Manual: 1, Failed: 0

TOTAL: Fixed: 2, Manual: 1, Failed: 0
```

## Known Issues

### Dev-Sync Clones from GitHub
The dev-sync workflow currently clones the infrastructure repo from GitHub (main branch) instead of using the local artifact. This means:
- Changes must be committed and pushed before dev-sync can test them
- The "artifact" created by dev-sync CLI is not actually used
- TODO: Implement actual artifact upload/download

### Workflow Still Shows Old Errors
After dev-sync, the fix workflow still shows "No SSH key found" errors. This suggests:
- The infrastructure on the server is not being updated properly, OR
- There's a caching issue with node_modules, OR
- The dev-sync is cloning from the wrong branch

## Next Steps

1. Debug why dev-sync isn't updating the running code on staging
2. Verify the infrastructure repo on staging server is using the latest code
3. Test that fix functions run without SSH errors
4. Verify per-stage result display works correctly
5. Verify workflow fails (red X) when fixes fail

## Testing Commands

```bash
# Test fix command
cd /Users/jon/factiii
npx factiii fix --staging

# Check workflow logs
gh run list --limit 1
gh run view <run-id> --log | grep "🔧 Running auto-fixes" -A 20

# Verify no "No SSH key found" errors in output
```

## Files Modified

- .cursorrules
- STANDARDS.md
- src/cli/fix.ts
- src/cli/scan.ts
- src/plugins/pipelines/factiii/index.ts
- src/plugins/servers/mac-mini/index.ts
- src/utils/github-workflow-monitor.ts
- src/plugins/pipelines/factiii/workflows/factiii-fix-staging.yml (new)
- src/plugins/pipelines/factiii/workflows/factiii-fix-prod.yml (new)
