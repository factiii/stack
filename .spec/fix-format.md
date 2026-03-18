# Fix Format

## Interface
```typescript
interface Fix {
  id: string;                    // kebab-case unique ID
  stage: Stage;                  // 'dev' | 'secrets' | 'staging' | 'prod'
  severity: Severity;            // 'critical' | 'warning' | 'info'
  description: string;           // Human-readable, emoji prefix ok
  plugin?: string;               // Plugin that owns this fix
  os?: ServerOS | ServerOS[];    // Optional: 'mac' | 'ubuntu' | 'windows' | 'amazon-linux' | 'alpine'
  targetStage?: 'staging' | 'prod'; // Optional: only for secrets stage differentiation
  scan: (config: FactiiiConfig, rootDir: string) => Promise<boolean>;  // true = issue found
  fix?: ((config: FactiiiConfig, rootDir: string) => Promise<boolean>) | null;  // true = fixed, null = manual only
  manualFix: string;             // Instructions if fix is null or fails
}
```

## Rules
- `scan` returns `true` when the issue EXISTS (needs fixing)
- `fix` returns `true` when successfully resolved
- `fix` can be `null` → manual-only fix, show `manualFix` string
- NO SSH in fix functions — fixes are local-only
- NO `GITHUB_ACTIONS` checks in fix functions
- Pipeline handles routing; fixes just operate on local filesystem/config

## Example
```typescript
{
  id: 'missing-env-file',
  stage: 'dev',
  severity: 'warning',
  description: '📋 .env file not found',
  scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
    return !fs.existsSync(path.join(rootDir, '.env'));
  },
  fix: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
    fs.copyFileSync(
      path.join(rootDir, '.env.example'),
      path.join(rootDir, '.env')
    );
    return true;
  },
  manualFix: 'Copy .env.example to .env and fill in values',
}
```

## Where fixes live
- Pipeline fixes: `src/plugins/pipelines/{name}/scanfix/*.ts`
- Export as `const someFixes: Fix[] = [...]`
- Collected in pipeline's `index.ts` via `static readonly fixes: Fix[] = [...allFixes]`
