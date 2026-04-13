# @factiii/stack

## 0.9.0

### Minor Changes

- 630de2a: Add AWS CLI passthrough, api-query, and db-query ops commands
  - `npx stack aws --<stage> "s3 ls"` — run AWS CLI commands with stage-appropriate credentials
  - `npx stack ops api-query --<stage> --url /api/health` — query server API routes
  - `npx stack ops db-query --<stage> --dangerous --sql "SELECT ..."` — read-only SQL via SSH
  - Extract reusable SSH helpers (resolveSSHTarget, sshExecCommand) in factiii pipeline

## 0.8.0

### Minor Changes

- 7dfe209: Split @factiii/auth 2FA into clean standard and device modes, and ship Claude Code skill scanfixes from @factiii/stack.

  **@factiii/auth**
  - `createAuthRouter` now selects its router shape from `features.twoFaMode`. Default is the new `'standard'` mode (user-centric TOTP with `User.twoFaSecret` + `User.twoFaBackupCodes`). Set `features.twoFaMode: 'device'` and pass a `deviceAuth: DeviceAuthAdapter` to opt into the legacy mobile-bound flow used by factiii.
  - New exports: `StandardAuthRouter`, `DeviceAuthRouter`, `TwoFaMode`, `DeviceAuthAdapter`, `createPrismaDeviceAdapter`, `AUTH_PRISMA_MODELS_STANDARD`, `AUTH_PRISMA_MODELS_DEVICE`, `getAuthPrismaModels`. `AuthRouter` is preserved as an alias of `StandardAuthRouter`.
  - Reference Prisma schema split: `prisma/schema.prisma` is now `prisma/schema.standard.prisma` (default) and `prisma/schema.device.prisma` (legacy). Update `package.json#exports` consumers — the old `./prisma/schema.prisma` subpath has been removed.
  - `SessionWithDevice` moved from `./adapters/database` to `./adapters/deviceAuth`.
  - Restored the required `User.updatedAt` column in both schema variants — login/refresh embed `updatedAt.toISOString()` in the cookie payload, so omitting it crashes auth at runtime.
  - Drops the redundant `User.twoFaEnabled` flag in standard mode; `twoFaSecret != null` is the source of truth.

  **@factiii/stack**
  - New `claude-skills` scanfix replaces the older `prod-check-skill` scanfix, installing the `commit`, `push`, and `prod-check` Claude Code skills under `~/.claude/skills/` for factiii-pipeline repos.

### Patch Changes

- Updated dependencies [7dfe209]
  - @factiii/auth@0.8.0

## 0.7.3

### Patch Changes

- cc2ca26: add prod-check Claude Code skill scanfix, gated on `claude_skills` opt-in in `stack.local.yml`. Off by default — `~/.claude/` is the developer's personal config and stack will not write to it unless explicitly enabled. STANDARDS.md documents the new "Host-Machine Fixes" rule that any future scanfix touching the dev's home directory must follow.

## 0.7.2

### Patch Changes

- 774979b: fix: 2FA recovery now accepts email or username
- Updated dependencies [774979b]
  - @factiii/auth@0.7.2

## 0.7.1

### Patch Changes

- 3abe40e: feat(auth): add magic link authentication and session integrity checks
  - Add magic link authentication support
  - Add session integrity checks to prevent cross-database user mismatch
  - Restructure monorepo — move stack to packages/stack, align versions to 0.7.0
  - Prevent repeated SSH password prompts during scan

- Updated dependencies [3abe40e]
  - @factiii/auth@0.7.1
