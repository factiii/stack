---
"@factiii/auth": patch
"@factiii/stack": patch
---

feat(auth): add magic link authentication and session integrity checks

- Add magic link authentication support
- Add session integrity checks to prevent cross-database user mismatch
- Restructure monorepo — move stack to packages/stack, align versions to 0.7.0
- Prevent repeated SSH password prompts during scan
