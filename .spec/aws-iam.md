# AWS IAM User Model

## Overview

Stack uses 3 IAM users per project — 1 admin for CLI operations, 2 scoped users for deployments.

## Naming Convention

All IAM users follow the pattern `factiii-{project}-{role}`:

| Role | IAM User Name | Example (project=myapp) |
|------|--------------|------------------------|
| Admin (dev/CI) | `factiii-{project}-admin` | `factiii-myapp-admin` |
| Prod (deploy) | `factiii-{project}-prod` | `factiii-myapp-prod` |

The `factiii-` prefix ensures all stack-managed users are identifiable in the AWS console.
If the project name is `factiii`, the user becomes `factiii-factiii-admin` — this is intentional.

## Users

| User | Name | Purpose | Permissions | Vault Keys |
|------|------|---------|-------------|------------|
| CLI Admin | User-created (e.g. `jon`) | CLI operations (provisioning, IAM management) | Admin/bootstrap policy | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| Dev | `factiii-{project}-admin` | Dev/CI read-only access, server .env | ECR read, S3 read, EC2/RDS describe | `DEV_AWS_ACCESS_KEY_ID`, `DEV_AWS_SECRET_ACCESS_KEY` |
| Prod | `factiii-{project}-prod` | Staging/prod deployments, server .env | ECR full, S3 full, EC2/RDS manage, SES full | `PROD_AWS_ACCESS_KEY_ID`, `PROD_AWS_SECRET_ACCESS_KEY` |

## Where Scoped Users Are Used

The dev and prod scoped users are **NOT** used by the CLI. They are used by:

1. **Server `.env` files** — injected into staging/prod `.env` so the deployed app can access AWS services (ECR pulls, S3 reads, etc.)
2. **CI/CD workflows** — GitHub Actions use these credentials for deployment pipelines
3. **Docker containers** — passed as environment variables to running containers

The CLI always uses the admin user (from `stack.yml` `access_key_id`).

## Security Model

**`~/.aws/credentials` is NEVER left populated.** It is written temporarily during a stack CLI run (synced from vault), then cleared when done. This prevents stale credentials from being used by other tools or leaking across projects.

**Scoped user credentials are NEVER printed to the terminal.** When the IAM fixes create dev/prod users, the secret keys are auto-stored directly in the Ansible Vault. They are only printed as a fallback if the vault is unavailable.

- **Ansible Vault** is the single source of truth for AWS secrets
- **`stack.yml`** stores only the `access_key_id` (public identifier, safe to commit)
- **`~/.aws/credentials`** is a temporary runtime cache — populated from vault at start, cleared at end

`aws configure` is only used once during initial bootstrap (first-time setup before vault exists). After that, the vault owns all credentials and `~/.aws/credentials` is managed exclusively by the stack CLI.

## Credential Flow

```
stack.yml
  └─ access_key_id: AKIA...       ← public identifier (committed to repo)

Ansible Vault (source of truth)
  ├─ AWS_ACCESS_KEY_ID: AKIA...   ← CLI admin key, must match stack.yml
  ├─ AWS_SECRET_ACCESS_KEY: ...   ← CLI admin secret
  ├─ DEV_AWS_ACCESS_KEY_ID: ...   ← dev scoped user (auto-stored on creation)
  ├─ DEV_AWS_SECRET_ACCESS_KEY: ...
  ├─ PROD_AWS_ACCESS_KEY_ID: ...  ← prod scoped user (auto-stored on creation)
  └─ PROD_AWS_SECRET_ACCESS_KEY: ...

~/.aws/credentials                ← temporary, written from vault, cleared after use
```

## Credential Sync (FIRST AWS operation)

Before ANY other AWS check runs, the credential sync fix must:

1. Read `access_key_id` from stack.yml
2. Read `AWS_ACCESS_KEY_ID` from Ansible Vault
3. Compare:
   - **Vault matches stack.yml** → write vault credentials to `~/.aws/credentials` + env vars, proceed
   - **Vault doesn't match stack.yml** → ask user what to do:
     - Option 1: Update `stack.yml` to match vault (if the vault key is correct)
     - Option 2: Update vault to match `stack.yml` (prompts for secret key, verifies, stores in vault)
   - **No vault credentials** → error, tell user to store admin credentials in vault
4. Only after sync passes do other AWS fixes run
5. After all AWS operations complete, clear `~/.aws/credentials` and env vars

## Mismatch Resolution

When vault `AWS_ACCESS_KEY_ID` ≠ stack.yml `access_key_id`, the user must choose:

| Option | When to use | Action |
|--------|-------------|--------|
| Update stack.yml | The vault key is the correct admin key | Write vault's `access_key_id` into stack.yml |
| Update vault | stack.yml has the correct key, vault is stale | Prompt for secret key, verify with STS, store in vault |

The CLI cannot silently pick one — the user must confirm which is correct.

## Key Rules

1. **Never leave `~/.aws/credentials` populated** — write from vault at start, clear at end
2. **Never print secret keys to terminal** — auto-store in vault on creation
3. **Vault is the single source of truth** for all AWS secrets
4. **`stack.yml` `access_key_id` must match vault** — mismatches block all AWS operations until resolved
5. **CLI always uses the admin user** — the key identified by stack.yml `access_key_id`
6. **Dev/prod scoped users are NOT for CLI** — they're for server .env, CI/CD, and containers
7. **`aws configure` is bootstrap-only** — used once for initial setup before vault exists, never again

## Fix Order

1. `aws-credentials-sync` (dev, **blocking**) — reads vault, verifies match with stack.yml, writes to `~/.aws/credentials`. MUST run before all other AWS fixes. If it fails, all subsequent fixes are skipped.
2. `aws-account-not-setup` (dev) — bootstraps credentials if nothing exists yet (first-time setup only)
3. `aws-region-configured` (dev) — ensures region is set in stack.yml
4. `aws-credentials-missing` (secrets) — ensures credentials exist in vault
5. `aws-iam-admin-user-missing` (secrets) — creates `factiii-{project}-admin` scoped user, stores creds in vault
6. `aws-iam-prod-user-missing` (secrets) — creates `factiii-{project}-prod` scoped user, stores creds in vault

## Policies

- **Bootstrap policy**: `src/plugins/pipelines/aws/policies/bootstrap-policy.json` — broad permissions for initial setup
- **Dev policy**: `getDevPolicy()` in `iam.ts` — ECR read, S3 read, EC2/RDS describe
- **Prod policy**: `getProdPolicy()` in `iam.ts` — ECR full, S3 full, EC2/RDS/SES manage
