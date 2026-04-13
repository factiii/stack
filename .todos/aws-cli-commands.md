# AWS CLI Commands & SSH IP Allowlist

## Status (2026-04)
**Partially implemented.** The `aws` command category, plugin-commands registration, and `aws` passthrough command are done on branch `ops-aws-and-others`. What remains is the vault-managed credential wrapper and the specific audited commands (whoami, ec2-list, sg-list, SSH allowlist).

## What's done
- `CommandCategory` extended with `'aws'` in `src/types/plugin.ts`
- `aws` registered as a top-level command in `src/cli/plugin-commands.ts` with positional args (`npx stack aws --staging "s3 ls"`)
- `aws` passthrough command in `src/plugins/pipelines/factiii/index.ts` — reads `~/.aws/credentials` on disk, auto-injects `--region`

## What remains

### TODO: `withAwsCredentials(stage, config, fn)` wrapper
- [ ] New util under `src/plugins/pipelines/aws/utils/` that reads vault via existing `AnsibleVaultSecrets`, sets env vars only for the callback's lifetime, never writes to disk
- [ ] Every `stack aws` command should run its SDK work inside this wrapper instead of relying on `~/.aws/credentials` existing on disk
- [ ] Support per-stage credential routing: optional `AWS_PROD_ACCESS_KEY_ID` / `AWS_PROD_SECRET_ACCESS_KEY` vault entries so `withAwsCredentials('prod', ...)` picks the prod IAM user when present, else falls back to the standard pair with a warning

### TODO: Specific audited commands (optional, beyond passthrough)
- [ ] `whoami` — `sts:GetCallerIdentity`, safe
- [ ] `ec2-list` — `ec2:DescribeInstances`, safe
- [ ] `sg-list` — `ec2:DescribeSecurityGroups`, safe
- [ ] These use the AWS SDK directly (not shelling out to `aws` CLI) via `withAwsCredentials`

### TODO: SSH IP allowlist commands
- [ ] `ssh-allow` — adds caller's public IP to the EC2 security group with `Description` label (`$USER@$hostname`, overridable with `--name`). Auto-revokes prior rule with same description if CIDR changed.
- [ ] `ssh-list` — lists current SSH ingress rules with owner labels
- [ ] `ssh-revoke` — removes a specific rule by label or CIDR. Refuses undescribed (manually-added) rules unless `--force`.
- [ ] Public IP via `https://checkip.amazonaws.com` (AWS-owned)
- [ ] Storage: native `Description` field on SG `IpRange` — no separate tag store

### TODO: `aws-sg-ssh-tighten` scanfix
- [ ] Scan-only warn fix that flags `0.0.0.0/0:22` with a `manualFix` string
- [ ] Don't auto-lock — too easy to lock people out until SSH allowlist commands are habitual

## Open questions
- Per-stage IAM user split: are dev/staging/prod vault entries already named? Currently only a single `factiii-admin` user is bootstrapped in `credentials.ts:113`.
- Stale-entry policy: should `ssh-list` flag entries older than N days?
- Should `ssh-revoke` of an undescribed rule require `--force` or refuse outright?

## Relevant files
- `src/types/plugin.ts` (~line 53) — `CommandCategory`
- `src/cli/plugin-commands.ts` (lines 123–143) — `aws` registration
- `src/plugins/pipelines/factiii/index.ts` (lines 1258+) — `aws` passthrough command
- `src/plugins/pipelines/aws/index.ts` — needs `commands[]` static
- `src/plugins/pipelines/aws/scanfix/credentials.ts` (line 113) — current vault → creds flow to mirror
- `src/plugins/pipelines/aws/scanfix/security-groups.ts` (line 61, 160–290) — existing SG ingress patterns
- `src/plugins/pipelines/aws/utils/aws-helpers.ts` (lines 103–128, 224–258) — `writeAwsCredentials`, cached client factories, `findSecurityGroup`
