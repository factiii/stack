---
'@factiii/stack': minor
'@factiii/auth': minor
---

Add agent/scripting mode to the stack CLI, separate the vault key from the personal password, and generate main-is-production deploy workflows.

**Agent mode** — `--json`, `--non-interactive`, and `--quiet` are now global flags usable on any command in any position (env equivalents `STACK_JSON`, `STACK_NONINTERACTIVE`, `STACK_QUIET`). In `--json` mode stdout carries exactly one result envelope and all logs move to stderr. Errors map to stable exit codes (1 FAILED, 2 NEEDS_INPUT, 3 UNREACHABLE, 4 VALIDATION), and prompts throw `NEEDS_INPUT` naming what to supply instead of hanging on stdin.

**Vault key separation** — the vault key and the password protecting it are no longer the same string. `rekey` generates a random 256-bit vault key, re-encrypts the vault with it, and stores only the key wrapped by a local personal password; the raw key never touches disk. The `missing-vault-password-file` scanfix generates a key on fresh setup or prompts to import the shared key when an encrypted vault already exists. Personal password minimum raised from 4 to 8 characters.

**Workflows** — `stack-cicd-prod.yml` is replaced by `stack-pr-staging.yml` (PR deploys staging) and `stack-prod.yml` (merge to main deploys prod), reflecting that main is the production branch. `WORKFLOW_VERSION` bumped to 2 so existing repos regenerate.

`@factiii/stack` is now unmaintained — see the README. This is its final feature release. `@factiii/auth` is unchanged in this release apart from added regression tests, and bumps to stay in lockstep with its linked package.
