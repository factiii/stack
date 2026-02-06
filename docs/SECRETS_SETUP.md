# Deploy Secrets - Quick Start

## Setup (One Time)

```bash
# Install Ansible
brew install ansible

# Create vault password file
echo "your-password-here" > ~/.vault_pass
chmod 600 ~/.vault_pass
```

## Add to factiii.yml

```yaml
ansible:
  vault_path: group_vars/all/vault.yml
  vault_password_file: ~/.vault_pass
```

## Store Secrets

```bash
# SSH keys
npx factiii secrets set STAGING_SSH
npx factiii secrets set PROD_SSH

# Environment variables
npx factiii secrets set-env DATABASE_URL --staging
npx factiii secrets set-env JWT_SECRET --staging
npx factiii secrets set-env DATABASE_URL --prod
npx factiii secrets set-env JWT_SECRET --prod
```

## Deploy

```bash
npx factiii secrets deploy --staging   # staging only
npx factiii secrets deploy --prod      # prod only
npx factiii secrets deploy --all       # both
```

## Check Status

```bash
npx factiii secrets list
```
