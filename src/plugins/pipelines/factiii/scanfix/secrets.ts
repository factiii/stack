/**
 * Ansible Vault Secrets fixes for Factiii Pipeline plugin
 * Handles Ansible Vault secrets validation for secrets stage
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { AnsibleVaultSecrets } from '../../../../utils/ansible-vault-secrets.js';
import { promptForSecret } from '../../../../utils/secret-prompts.js';

function getAnsibleStore(config: FactiiiConfig, rootDir: string): AnsibleVaultSecrets | null {
  if (!config.ansible?.vault_path) return null;
  return new AnsibleVaultSecrets({
    vault_path: config.ansible.vault_path,
    vault_password_file: config.ansible.vault_password_file,
    rootDir,
  });
}

function getSecretNameFromFixId(fixId: string): string {
  const map: Record<string, string> = {
    'missing-staging-ssh': 'STAGING_SSH',
    'missing-prod-ssh': 'PROD_SSH',
    'missing-aws-secret': 'AWS_SECRET_ACCESS_KEY',
  };
  return map[fixId] ?? '';
}

export const secretsFixes: Fix[] = [
  {
    id: 'missing-ansible-config',
    stage: 'secrets',
    severity: 'critical',
    description: '🔐 Ansible Vault not configured (ansible.vault_path missing in stack.yml)',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      return !config.ansible?.vault_path;
    },
    fix: null,
    manualFix:
      'Add ansible section to stack.yml:\n' +
      '  ansible:\n' +
      '    vault_path: group_vars/all/vault.yml\n' +
      '    vault_password_file: ~/.vault_pass  # optional',
  },
  {
    id: 'missing-staging-ssh',
    stage: 'secrets',
    severity: 'critical',
    description: '🔑 STAGING_SSH secret not found in Ansible Vault',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const { extractEnvironments } = await import('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);

      // Only check if staging environment is defined in config
      const hasStagingEnv = environments.staging;
      if (!hasStagingEnv) return false; // Skip check if staging not configured

      const store = getAnsibleStore(config, rootDir);
      if (!store) return false; // Will be caught by missing-ansible-config fix

      const result = await store.checkSecrets(['STAGING_SSH']);
      return result.missing?.includes('STAGING_SSH') ?? false;
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const store = getAnsibleStore(config, rootDir);
      if (!store) return false;

      try {
        const value = await promptForSecret('STAGING_SSH', config);
        const result = await store.setSecret('STAGING_SSH', value);
        if (!result.success) return false;

        const sshDir = path.join(os.homedir(), '.ssh');
        if (!fs.existsSync(sshDir)) {
          fs.mkdirSync(sshDir, { mode: 0o700 });
        }
        const keyPath = path.join(sshDir, 'staging_deploy_key');
        fs.writeFileSync(keyPath, value.trimEnd() + '\n', { mode: 0o600 });
        console.log('      Wrote STAGING_SSH → ' + keyPath);
        return true;
      } catch {
        return false;
      }
    },
    manualFix:
      'Store your staging SSH key in the vault:\n' +
      '      1. Generate key: ssh-keygen -t ed25519 -C "staging-deploy" -f ~/.ssh/staging_deploy_key\n' +
      '      2. Add to server: ssh-copy-id -i ~/.ssh/staging_deploy_key.pub user@staging-host\n' +
      '      3. Store in vault: npx stack secrets set STAGING_SSH',
  },
  {
    id: 'missing-prod-ssh',
    stage: 'secrets',
    severity: 'critical',
    description: '🔑 PROD_SSH secret not found in Ansible Vault',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const { extractEnvironments } = await import('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);

      // Only check if prod environment is defined in config
      const hasProdEnv = environments.prod;
      if (!hasProdEnv) return false; // Skip check if prod not configured

      const store = getAnsibleStore(config, rootDir);
      if (!store) return false; // Will be caught by missing-ansible-config fix

      const result = await store.checkSecrets(['PROD_SSH']);
      return result.missing?.includes('PROD_SSH') ?? false;
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const store = getAnsibleStore(config, rootDir);
      if (!store) return false;

      try {
        const value = await promptForSecret('PROD_SSH', config);
        const result = await store.setSecret('PROD_SSH', value);
        if (!result.success) return false;

        const sshDir = path.join(os.homedir(), '.ssh');
        if (!fs.existsSync(sshDir)) {
          fs.mkdirSync(sshDir, { mode: 0o700 });
        }
        const keyPath = path.join(sshDir, 'prod_deploy_key');
        fs.writeFileSync(keyPath, value.trimEnd() + '\n', { mode: 0o600 });
        console.log('      Wrote PROD_SSH → ' + keyPath);
        return true;
      } catch {
        return false;
      }
    },
    manualFix:
      'Store your prod SSH key in the vault:\n' +
      '      1. Generate key: ssh-keygen -t ed25519 -C "prod-deploy" -f ~/.ssh/prod_deploy_key\n' +
      '      2. Add to server: ssh-copy-id -i ~/.ssh/prod_deploy_key.pub user@prod-host\n' +
      '      3. Store in vault: npx stack secrets set PROD_SSH',
  },
  {
    id: 'missing-aws-secret',
    stage: 'secrets',
    severity: 'warning',
    description: '🔑 AWS_SECRET_ACCESS_KEY not found in Ansible Vault (needed for ECR)',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const { extractEnvironments } = await import('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);

      // Check if any environment uses AWS pipeline
      const hasAwsEnv = Object.values(environments).some(env =>
        env.pipeline === 'aws' && env.access_key_id
      );
      if (!hasAwsEnv) return false;

      const store = getAnsibleStore(config, rootDir);
      if (!store) return false; // Will be caught by missing-ansible-config fix

      const result = await store.checkSecrets(['AWS_SECRET_ACCESS_KEY']);
      return result.missing?.includes('AWS_SECRET_ACCESS_KEY') ?? false;
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const store = getAnsibleStore(config, rootDir);
      if (!store) return false;

      try {
        const value = await promptForSecret('AWS_SECRET_ACCESS_KEY', config);
        const result = await store.setSecret('AWS_SECRET_ACCESS_KEY', value);
        return result.success;
      } catch {
        return false;
      }
    },
    manualFix:
      'Set AWS_SECRET_ACCESS_KEY secret: npx stack secrets set AWS_SECRET_ACCESS_KEY',
  },
  {
    id: 'missing-vault-password-file',
    stage: 'secrets',
    severity: 'critical',
    description: '🔐 Vault password file not found (required to decrypt secrets)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!config.ansible?.vault_path) return false; // Will be caught by missing-ansible-config
      if (!config.ansible.vault_password_file) return false; // Not using password file

      const passwordFile = config.ansible.vault_password_file.replace(/^~/, os.homedir());
      return !fs.existsSync(passwordFile);
    },
    fix: null,
    manualFix:
      'Create the vault password file specified in stack.yml ansible.vault_password_file:\n' +
      '      macOS/Linux: echo "your-vault-password" > ~/.vault_pass && chmod 600 ~/.vault_pass\n' +
      '      Windows:     echo your-vault-password > %USERPROFILE%\\.vault_pass\n' +
      '      Or run: npx stack init (will guide you through vault setup)',
  },
  {
    id: 'missing-ssh-key-staging',
    stage: 'secrets',
    severity: 'critical',
    description: '🔑 SSH_STAGING key file not on disk (required for staging access)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      const { extractEnvironments } = await import('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);

      if (!environments.staging) return false;

      const keyPath = path.join(os.homedir(), '.ssh', 'staging_deploy_key');
      return !fs.existsSync(keyPath);
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const store = getAnsibleStore(config, rootDir);
      if (!store) return false;

      try {
        const key = await store.getSecret('STAGING_SSH');
        if (!key) {
          console.log('      STAGING_SSH not in vault yet — set it first: npx stack secrets set STAGING_SSH');
          return false;
        }

        const sshDir = path.join(os.homedir(), '.ssh');
        if (!fs.existsSync(sshDir)) {
          fs.mkdirSync(sshDir, { mode: 0o700 });
        }

        const keyPath = path.join(sshDir, 'staging_deploy_key');
        fs.writeFileSync(keyPath, key.trimEnd() + '\n', { mode: 0o600 });
        console.log('      Wrote STAGING_SSH → ' + keyPath);
        return true;
      } catch {
        return false;
      }
    },
    manualFix:
      'Extract SSH keys from vault: npx stack secrets write-ssh-keys',
  },
  {
    id: 'missing-ssh-key-prod',
    stage: 'secrets',
    severity: 'critical',
    description: '🔑 SSH_PROD key file not on disk (required for prod access)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      const { extractEnvironments } = await import('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);

      if (!environments.prod) return false;

      const keyPath = path.join(os.homedir(), '.ssh', 'prod_deploy_key');
      return !fs.existsSync(keyPath);
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const store = getAnsibleStore(config, rootDir);
      if (!store) return false;

      try {
        const key = await store.getSecret('PROD_SSH');
        if (!key) {
          console.log('      PROD_SSH not in vault yet — set it first: npx stack secrets set PROD_SSH');
          return false;
        }

        const sshDir = path.join(os.homedir(), '.ssh');
        if (!fs.existsSync(sshDir)) {
          fs.mkdirSync(sshDir, { mode: 0o700 });
        }

        const keyPath = path.join(sshDir, 'prod_deploy_key');
        fs.writeFileSync(keyPath, key.trimEnd() + '\n', { mode: 0o600 });
        console.log('      Wrote PROD_SSH → ' + keyPath);
        return true;
      } catch {
        return false;
      }
    },
    manualFix:
      'Extract SSH keys from vault: npx stack secrets write-ssh-keys',
  },
];

