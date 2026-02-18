# Ansible Vault Setup Guide

## Overview

Ansible Vault encrypts sensitive data (SSH keys, environment variables, API keys) so they can be stored alongside your code without exposing secrets. This replaces storing secrets in GitHub Secrets.

**Key concept:** Secrets are encrypted at rest in a vault file. A single vault password unlocks all secrets. You control this password - it never leaves your machine.

---

## Prerequisites

```bash
# Install Ansible (includes ansible-vault)
pip install ansible

# Verify installation
ansible-vault --version
```

---

## Step 1: Create a Vault Password

You need ONE password that encrypts/decrypts all vault secrets. Choose one storage method:

### Option A: Password File (Recommended for Dev Machines)

```bash
# Generate a strong random password
openssl rand -base64 32 > ~/.vault_pass

# Restrict permissions (critical!)
chmod 600 ~/.vault_pass

# Tell Ansible where to find it
export ANSIBLE_VAULT_PASSWORD_FILE=~/.vault_pass
```

Add to your shell profile (`~/.bashrc`, `~/.zshrc`):
```bash
export ANSIBLE_VAULT_PASSWORD_FILE=~/.vault_pass
```

### Option B: Environment Variable

```bash
# Set directly (useful for CI or containers)
export ANSIBLE_VAULT_PASSWORD="your-strong-password-here"
```

### Option C: Factiii Config (factiii.yml)

```yaml
ansible:
  vault_path: ./group_vars/all/vault.yml
  vault_password_file: ~/.vault_pass
```

### Security Rules for Vault Password

- **NEVER** commit the vault password to git
- **NEVER** share it over unencrypted channels
- Store it in a password manager (1Password, Bitwarden, etc.)
- Each developer should have their own copy
- Add to `.gitignore`: `*.vault_pass`, `.vault_pass`

---

## Step 2: Create the Vault File

```bash
# Create encrypted vault file
ansible-vault create ansible/vault/secrets.yml
```

This opens your editor. Add your secrets in YAML format:

```yaml
---
# SSH Keys
# Paste the FULL private key content (including BEGIN/END lines)
staging_ssh_key: |
  -----BEGIN OPENSSH PRIVATE KEY-----
  your-staging-key-content-here
  -----END OPENSSH PRIVATE KEY-----

prod_ssh_key: |
  -----BEGIN OPENSSH PRIVATE KEY-----
  your-prod-key-content-here
  -----END OPENSSH PRIVATE KEY-----

mac_ssh_key: |
  -----BEGIN OPENSSH PRIVATE KEY-----
  your-mac-key-content-here
  -----END OPENSSH PRIVATE KEY-----

# Environment Variables (base64 encoded or raw)
staging_envs: |
  DATABASE_URL=postgres://...
  REDIS_URL=redis://...
  API_KEY=sk-...

prod_envs: |
  DATABASE_URL=postgres://...
  REDIS_URL=redis://...
  API_KEY=sk-...

# AWS Credentials (if applicable)
aws_access_key_id: "AKIA..."
aws_secret_access_key: "your-secret-key"
```

Save and close. The file is now encrypted.

### Or Use the Factiii CLI

```bash
# Store individual secrets via CLI
npx stack secrets set STAGING_SSH    # Prompts for SSH key
npx stack secrets set PROD_SSH       # Prompts for SSH key
npx stack secrets set MAC_SSH        # Prompts for SSH key

# Verify secrets are stored
npx stack secrets list
```

---

## Step 3: Extract SSH Keys for Use

SSH keys must be written to disk (unencrypted) for SSH to use them. Extract them when needed:

### Using Factiii CLI

```bash
# Extract all SSH keys from vault to ~/.ssh/
npx stack secrets write-ssh-keys
```

This writes:
- `~/.ssh/staging_deploy_key`
- `~/.ssh/prod_deploy_key`

### Manual Extraction

```bash
# View a secret (outputs to terminal)
ansible-vault view ansible/vault/secrets.yml

# Or decrypt to a temp variable
STAGING_KEY=$(ansible-vault view ansible/vault/secrets.yml | grep -A 100 'staging_ssh_key' | sed '1d' | sed '/^[a-z]/,$d')

# Write to file with correct permissions
echo "$STAGING_KEY" > ~/.ssh/staging_deploy_key
chmod 600 ~/.ssh/staging_deploy_key
```

---

## Step 4: Common Operations

### View Encrypted Secrets

```bash
ansible-vault view ansible/vault/secrets.yml
```

### Edit Secrets

```bash
ansible-vault edit ansible/vault/secrets.yml
```

### Add a New Secret

```bash
# Edit the vault file and add the new key-value pair
ansible-vault edit ansible/vault/secrets.yml
```

### Re-encrypt with a New Password

```bash
ansible-vault rekey ansible/vault/secrets.yml
# Prompts for old password, then new password
```

### Encrypt an Existing File

```bash
# Encrypt a plain .env file
ansible-vault encrypt .env.staging
```

### Decrypt a File (Temporarily)

```bash
# Decrypt in-place (careful - will be unencrypted!)
ansible-vault decrypt ansible/vault/secrets.yml

# Re-encrypt when done
ansible-vault encrypt ansible/vault/secrets.yml
```

---

## Step 5: SSH Key Permissions

SSH is strict about key file permissions. After extracting keys:

```bash
# Set correct permissions on all deploy keys
chmod 600 ~/.ssh/staging_deploy_key
chmod 600 ~/.ssh/prod_deploy_key
chmod 600 ~/.ssh/mac_deploy_key

# Verify permissions
ls -la ~/.ssh/*_deploy_key
# Should show: -rw------- (600)
```

**Common error if permissions are wrong:**
```
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
```

---

## Secret Storage Structure

```
~/.vault_pass                          # Vault password (NEVER commit)
~/.ssh/
├── staging_deploy_key                 # Extracted from vault
├── prod_deploy_key                    # Extracted from vault
└── mac_deploy_key                     # Extracted from vault

ansible/vault/
└── secrets.yml                        # Encrypted vault file (safe to commit)

# Factiii CLI vault path (in app repos):
group_vars/all/vault.yml               # Encrypted vault file
```

---


## Troubleshooting

### "Decryption failed"
- Wrong vault password. Check `~/.vault_pass` content matches team password.

### "ERROR! input is not vault encrypted data"
- File was already decrypted, or is not a vault file.

### SSH key not working after extraction
- Check permissions: `ls -la ~/.ssh/*_deploy_key`
- Ensure the public key is in the server's `authorized_keys`
- Test manually: `ssh -i ~/.ssh/staging_deploy_key -v user@host`

---

## Next Steps

1. Create your vault password: `openssl rand -base64 32 > ~/.vault_pass`
2. Add existing SSH keys to vault: `npx stack secrets set STAGING_SSH`
3. Run verification: `./ansible/scripts/verify-secrets.sh`
4. Test connectivity: `./ansible/scripts/ssh-test.sh`
