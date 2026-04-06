# Config System

## Files (loaded in order, later overrides earlier)
| File | Purpose | Editable by | Git |
|------|---------|-------------|-----|
| `stack.yml` | Manual shared settings | User | tracked |
| `stackAuto.yml` | Auto-detected values | Stack CLI | tracked |
| `stack.local.yml` | Per-developer settings | User | gitignored |

Legacy: `factiii.yml` still supported as alternate name.

## Environment Detection
Environments are top-level keys in `stack.yml` that are NOT in `RESERVED_CONFIG_KEYS`.

```typescript
// src/utils/config-helpers.ts
extractEnvironments(config)  // returns Record<string, EnvironmentConfig>
```

Reserved keys (not environments): `name`, `config_version`, `github_repo`, `ssl_email`, `pipeline`, `prisma_schema`, `prisma_version`, `trusted_plugins`, `container_exclusions`, `ansible`, `dev_only`, `env_match_exceptions`.

## stack.yml Example
```yaml
name: myapp
github_repo: org/myapp
pipeline: factiii

staging:
  server: ubuntu
  domain: staging.myapp.com
  ssh_user: deploy

prod:
  server: ubuntu
  domain: myapp.com
  ssh_user: deploy
```

## stackAuto.yml
Auto-populated by generators. User can override with `OVERRIDE` pattern. Contains detected values: `ssh_user`, `dockerfile`, `package_manager`, `node_version`, `pnpm_version`, `prisma_schema`, `prisma_version`, AWS resource IDs.

## stack.local.yml
Per-developer. Key fields:
- `dev_os`: mac | ubuntu | windows (auto-detected)
- `dev_only`: true (default) — set false to unlock staging/prod stages

## Key Utilities
```
src/utils/config-helpers.ts  — extractEnvironments(), loadLocalConfig(), LocalConfig
src/constants/config-files.ts — STACK_CONFIG_FILENAME, getStackConfigPath(), etc.
src/generators/generate-stack-yml.ts — Auto-detects name, github_repo, frameworks
src/generators/generate-stack-auto.ts — Detects package manager, node version, etc.
```
