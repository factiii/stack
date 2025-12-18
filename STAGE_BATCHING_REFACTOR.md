# Stage Batching Refactor - Implementation Status

## Completed
1. ✅ Added Stage Batching Architecture to STANDARDS.md
2. ✅ Added Stage Batching section to .cursorrules

## In Progress
3. ⏳ Remove isOnServer/SSH logic from individual fix functions

## Remaining Work

### Part 2: Simplify Fix Functions (mac-mini plugin)

**Pattern to apply to ALL staging fixes:**

**BEFORE (current - WRONG):**
```typescript
scan: async (config, rootDir) => {
  const isOnServer = process.env.GITHUB_ACTIONS === 'true';
  if (isOnServer) {
    execSync('which docker', { stdio: 'pipe' });
  } else {
    await MacMiniPlugin.sshExec(config.environments.staging, 'which docker');
  }
}
```

**AFTER (should be - RIGHT):**
```typescript
scan: async (config, rootDir) => {
  // Executed locally - SSH handled by CLI wrapper
  try {
    execSync('which docker', { stdio: 'pipe' });
    return false; // Docker installed
  } catch {
    return true; // Docker not installed
  }
}
```

**Fixes to update:**
- staging-docker-missing (scan + fix)
- staging-docker-not-running (scan + fix)
- staging-docker-autostart (scan + fix)
- staging-node-missing (scan + fix)
- staging-git-missing (scan + fix)
- staging-pnpm-missing (scan + fix)
- staging-old-containers (scan + fix - already local)

### Part 3: CLI Already Handles --on-server

The CLI in scan.ts and fix.ts already has the `--on-server` check at lines 363-368 (scan.ts) and 144-149 (fix.ts). This is CORRECT and should stay.

### Part 4: Result Display

Already implemented in fix.ts lines 230-256 - shows per-stage breakdown.

## Key Architecture Points

1. **CLI checks `--on-server` ONCE** - Already done in scan.ts/fix.ts
2. **Workflows SSH ONCE** - Already correct in YML files
3. **Fix functions run locally** - NEEDS FIX (remove isOnServer checks)
4. **Clean results per stage** - Already done

## Next Steps

1. Remove all `isOnServer` checks from mac-mini plugin fix functions
2. Remove all SSH calls from mac-mini plugin fix functions  
3. Add comment to each: "// Executed locally - SSH handled by CLI wrapper"
4. Build and test
5. Verify ONE SSH call per stage in workflow logs

