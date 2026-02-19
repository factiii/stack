# Deploy Secrets - Quick Start

## Setup (One Time)

```bash
# Install Ansible
brew install ansible

# Create vault password file
echo "your-password-here" > ~/.vault_pass
chmod 600 ~/.vault_pass
```

## Add to stack.yml

```yaml
ansible:
  vault_path: group_vars/all/vault.yml
  vault_password_file: ~/.vault_pass
```

## Store Secrets

```bash
# SSH keys
npx stack secrets set STAGING_SSH
npx stack secrets set PROD_SSH

# Environment variables
npx stack secrets set-env DATABASE_URL --staging
npx stack secrets set-env JWT_SECRET --staging
npx stack secrets set-env DATABASE_URL --prod
npx stack secrets set-env JWT_SECRET --prod
```

## Deploy

```bash
npx stack secrets deploy --staging   # staging only
npx stack secrets deploy --prod      # prod only
npx stack secrets deploy --all       # both
```

## Check Status

```bash
npx stack secrets list
```
