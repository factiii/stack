# v1.0.0 Release Criteria

## API Stability
- Public exports in `@factiii/auth` (router, config, adapters, validators) are settled — no more renaming or restructuring
- `@factiii/stack` CLI commands and flags are stable — users won't need to relearn
- Config file format (`stack.yml`, auth config shape) won't have breaking changes
- The `stackPlugin` contract between auth and stack is finalized

## Feature Completeness
- Auth: Both adapters (Prisma + Drizzle) battle-tested in production
- Auth: OAuth, 2FA, email verification, password reset all working end-to-end
- Stack: Full deploy cycle (0-to-deployed) works reliably for at least 2-3 real projects
- Stack: AWS provisioning path is stable (EC2, RDS, VPC, ECR)
- The inline fallback scanfixes in stack are gone — auth exports its own via `stackPlugin.fixes`

## Quality Gates
- E2E tests cover the critical auth flows
- Stack tests cover scan/fix/deploy for each stage
- No known data-loss or security bugs open
- At least one production app running on it

## Docs & DX
- README for both packages covers setup, config, and common workflows
- Breaking changes from pre-1.0 are documented in a migration guide

## Rule of Thumb
When you stop making breaking changes out of necessity and start making them by choice, you're at 1.0.
