# Vault Rekey Spec (Factiii Pipeline Plugin)

## Scope

This spec is for the **factiii pipeline plugin** (`packages/stack/src/plugins/pipelines/factiii/`).
The server OS per stage depends on which **server plugin** is loaded (mac, ubuntu, amazon-linux, etc.).
For example, staging may run on a Mac server while prod runs on AWS EC2 (Ubuntu).
SSH key rotation must work regardless of server plugin — the steps are OS-agnostic.

## Problem

The vault file is committed to git (encrypted). If someone who had the vault password leaves the team or is compromised, they can check out any old commit and decrypt the vault with the old password. Rekeying the vault password alone only protects future commits — every secret inside the vault at the time of compromise is exposed.

**Rekey must rotate the actual secrets, not just the encryption password.**

## Command

```bash
npx stack deploy --secrets rekey
```

Interactive, walks through each step with confirmations. Each step can be skipped.

---

## Steps

### Step 1: Rekey Vault Password (auto)

- Generate new random password (or prompt user for one)
- Decrypt vault with old password, re-encrypt with new
- Update `~/.vault_pass`
- Print reminders:
  - Update GitHub Secret `ANSIBLE_VAULT_PASSWORD` if used
  - Distribute new password to team via password manager

### Step 2: Rotate SSH Keys (auto, per stage)

For each stage (`staging`, `prod`) that has an SSH key in vault.
The target server OS varies by server plugin (e.g., staging on Mac, prod on EC2/Ubuntu).
SSH key rotation is OS-agnostic — uses standard `authorized_keys` on all platforms.

1. Generate new ed25519 keypair locally
2. SSH into server with OLD key
3. Append new public key to `authorized_keys`
4. Test SSH with new key
5. Remove old public key from `authorized_keys`
6. Store new private key in vault
7. Write new key to `~/.ssh/{stage}_deploy_key`

**Chicken-and-egg:** Must complete SSH rotation BEFORE deleting old key. If step 4 fails, roll back (remove new key from `authorized_keys`).

### Step 3: Rotate AWS Credentials (auto, AWS stages only)

Only applies to stages with AWS config (e.g., prod on EC2). Skipped for non-AWS stages (e.g., staging on Mac).
Uses existing AWS SDK access (old creds still valid during rotation):

1. `IAM.CreateAccessKey()` — create new key pair for current IAM user
2. Store new `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` in vault
3. Sync to `~/.aws/credentials`
4. Verify new creds work via `STS.GetCallerIdentity()`
5. `IAM.DeleteAccessKey()` — delete old key pair
6. If step 4 fails, roll back (delete new key, keep old)

**Note:** AWS limits 2 active access keys per IAM user, so create-then-delete works.

### Step 4: Flag Environment Secrets for Manual Rotation

Cannot auto-rotate external service credentials. Instead:

1. Read all keys from `staging_envs` and `prod_envs`
2. Categorize each key:
   - **Auto-rotatable:** (none currently — future: DB passwords if we add RDS password rotation)
   - **Manual rotation required:** everything else
3. Print checklist grouped by likely service:
   - `DATABASE_URL` → "Rotate password in RDS/DB console, update here"
   - `*_API_KEY` / `*_SECRET` → "Regenerate in provider dashboard"
   - `*_TOKEN` → "Regenerate token"
   - Other → "Review and rotate if sensitive"
4. For each, print: `npx stack deploy --secrets set-env <KEY> --<stage>`

### Step 5: Redeploy

After all rotations:

1. Prompt to run `npx stack deploy --secrets deploy` to push updated env vars to servers
2. Prompt to restart services so new secrets take effect
3. Print final summary of what was rotated vs. what needs manual attention

---

## Implementation

### New file: `packages/stack/src/plugins/pipelines/factiii/scanfix/rekey.ts`

Exports:
- `rekeyVaultPassword(config, rootDir)` — step 1 (refactored from existing `changeVaultPassword`)
- `rotateSSHKeys(config, rootDir)` — step 2
- `rotateAWSCredentials(config, rootDir)` — step 3
- `printManualRotationReport(config, rootDir)` — step 4
- `rekeyAll(config, rootDir)` — orchestrator, runs steps 1-5 interactively

### Modified: `packages/stack/src/plugins/pipelines/factiii/index.ts`

- Add `rekey` command to `commands[]` that calls `rekeyAll()`
- Keep existing `change-vault-password` command as-is (vault-password-only change for non-compromise scenarios)
- Refactor `changeVaultPassword()` to call `rekeyVaultPassword()` internally (DRY)

### Dependencies

- `ssh-keygen` (system) — for ed25519 key generation
- AWS SDK v3 `@aws-sdk/client-iam` + `@aws-sdk/client-sts` — already available
- `ansible-vault` npm — already available
- `ssh-helper.ts` — `sshExec()` for remote `authorized_keys` updates

---

## Edge Cases

- **No SSH key in vault:** Skip step 2 for that stage
- **No AWS creds in vault:** Skip step 3 entirely
- **No env vars in vault:** Skip step 4
- **SSH connection fails during rotation:** Roll back (remove new pubkey if added), report error, continue to next step
- **AWS CreateAccessKey fails (2 key limit):** Report that user must manually delete one key first
- **Vault password file doesn't exist:** Error out early (same as current behavior)

## What This Does NOT Cover

- JWT secret rotation and session migration — see `packages/auth/.spec/rekey.md`
- OAuth credential rotation (Google, Apple) — manual, provider console
- Vercel token rotation — manual, Vercel dashboard
- Git history rewriting (force-pushing to remove old vault files) — out of scope, not recommended
