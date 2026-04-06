# @factiii/stack

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
