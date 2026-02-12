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
    description: 'Ansible Vault not configured (ansible.vault_path missing in factiii.yml)',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      return !config.ansible?.vault_path;
    },
    fix: null,
    manualFix:
      'Add ansible section to factiii.yml:\n' +
      '  ansible:\n' +
      '    vault_path: group_vars/all/vault.yml\n' +
      '    vault_password_file: ~/.vault_pass  # optional',
  },
  {
    id: 'missing-staging-ssh',
    stage: 'secrets',
    severity: 'critical',
    description: 'STAGING_SSH secret not found in Ansible Vault',
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
        return result.success;
      } catch {
        return false;
      }
    },
    manualFix:
      'Set STAGING_SSH secret: npx factiii secrets set STAGING_SSH',
  },
  {
    id: 'missing-prod-ssh',
    stage: 'secrets',
    severity: 'critical',
    description: 'PROD_SSH secret not found in Ansible Vault',
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
        return result.success;
      } catch {
        return false;
      }
    },
    manualFix:
      'Set PROD_SSH secret: npx factiii secrets set PROD_SSH',
  },
  {
    id: 'missing-aws-secret',
    stage: 'secrets',
    severity: 'warning',
    description: 'AWS_SECRET_ACCESS_KEY not found in Ansible Vault (needed for ECR)',
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
      'Set AWS_SECRET_ACCESS_KEY secret: npx factiii secrets set AWS_SECRET_ACCESS_KEY',
  },
  {
    id: 'missing-vault-password-file',
    stage: 'secrets',
    severity: 'critical',
    description: 'Vault password file not found (required to decrypt secrets)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!config.ansible?.vault_path) return false; // Will be caught by missing-ansible-config
      if (!config.ansible.vault_password_file) return false; // Not using password file

      const passwordFile = config.ansible.vault_password_file.replace(/^~/, os.homedir());
      return !fs.existsSync(passwordFile);
    },
    fix: null,
    manualFix:
      'Create the vault password file specified in factiii.yml ansible.vault_password_file\n' +
      '  Example: echo "your-vault-password" > ~/.vault_pass && chmod 600 ~/.vault_pass',
  },
  {
    id: 'missing-ssh-key-staging',
    stage: 'secrets',
    severity: 'critical',
    description: 'SSH key file ~/.ssh/staging_deploy_key not found (required for staging access)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      const { extractEnvironments } = await import('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);

      // Only check if staging environment is defined
      if (!environments.staging) return false;

      const keyPath = path.join(os.homedir(), '.ssh', 'staging_deploy_key');
      return !fs.existsSync(keyPath);
    },
    fix: null,
    manualFix:
      'Extract SSH keys from vault: npx factiii secrets write-ssh-keys',
  },
  {
    id: 'missing-ssh-key-prod',
    stage: 'secrets',
    severity: 'critical',
    description: 'SSH key file ~/.ssh/prod_deploy_key not found (required for prod access)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      const { extractEnvironments } = await import('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);

      // Only check if prod environment is defined
      if (!environments.prod) return false;

      const keyPath = path.join(os.homedir(), '.ssh', 'prod_deploy_key');
      return !fs.existsSync(keyPath);
    },
    fix: null,
    manualFix:
      'Extract SSH keys from vault: npx factiii secrets write-ssh-keys',
  },
];

