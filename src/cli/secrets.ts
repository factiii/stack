/**
 * Secrets Command
 *
 * Manages secrets via Ansible Vault
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import yaml from 'js-yaml';
import { AnsibleVaultSecrets } from '../utils/ansible-vault-secrets.js';
import { promptForSecret } from '../utils/secret-prompts.js';
import type { SecretsOptions, FactiiiConfig } from '../types/index.js';

function loadConfig(rootDir: string): FactiiiConfig {
  const configPath = path.join(rootDir, 'factiii.yml');
  if (!fs.existsSync(configPath)) {
    throw new Error('factiii.yml not found. Run: npx factiii init');
  }
  try {
    return (yaml.load(fs.readFileSync(configPath, 'utf8')) as FactiiiConfig) ?? ({} as FactiiiConfig);
  } catch (e) {
    throw new Error(`Error parsing factiii.yml: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function secrets(
  action: 'list' | 'set' | 'check' | 'write-ssh-keys',
  secretName?: string,
  options: SecretsOptions = {}
): Promise<void> {
  const rootDir = options.rootDir ?? process.cwd();
  const config = loadConfig(rootDir);

  if (!config.ansible?.vault_path) {
    throw new Error(
      'ansible.vault_path not configured in factiii.yml. Add:\n' +
      '  ansible:\n' +
      '    vault_path: group_vars/all/vault.yml\n' +
      '    vault_password_file: ~/.vault_pass  # optional'
    );
  }

  const store = new AnsibleVaultSecrets({
    vault_path: config.ansible.vault_path,
    vault_password_file: config.ansible.vault_password_file,
    rootDir,
  });

  switch (action) {
    case 'list': {
      console.log('📋 Checking Ansible Vault secrets...\n');
      const required = ['STAGING_SSH', 'PROD_SSH', 'AWS_SECRET_ACCESS_KEY'];
      const result = await store.checkSecrets(required);

      if (result.error) {
        console.log(`❌ Error: ${result.error}`);
        return;
      }

      for (const name of required) {
        const exists = result.status?.[name] ?? false;
        const icon = exists ? '✅' : '⚠️';
        const status = exists ? 'exists' : 'missing';
        console.log(`   ${icon} ${name}: ${status}`);
      }
      if (result.missing && result.missing.length > 0) {
        console.log(`\n💡 Missing secrets: ${result.missing.join(', ')}`);
        console.log(`   Set them with: npx factiii secrets set <name>`);
      }
      break;
    }

    case 'set': {
      if (!secretName) {
        console.log('❌ Secret name required');
        return;
      }

      let value = options.value;
      if (!value) {
        value = await promptForSecret(secretName, config);
      }

      console.log(`\n📝 Setting ${secretName} in Ansible Vault...`);
      const result = await store.setSecret(secretName, value);

      if (result.success) {
        console.log(`✅ ${secretName} set successfully in ${config.ansible.vault_path}`);
      } else {
        console.log(`❌ Failed to set ${secretName}: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'check': {
      const secretNames = secretName ? [secretName] : ['STAGING_SSH', 'PROD_SSH', 'AWS_SECRET_ACCESS_KEY'];
      const result = await store.checkSecrets(secretNames);

      if (result.error) {
        console.log(`❌ Error: ${result.error}`);
        return;
      }

      for (const name of secretNames) {
        const exists = result.status?.[name] ?? false;
        console.log(`${exists ? '✅' : '❌'} ${name}`);
      }
      break;
    }

    case 'write-ssh-keys': {
      const stagingKey = await store.getSecret('STAGING_SSH');
      const prodKey = await store.getSecret('PROD_SSH');

      const sshDir = path.join(os.homedir(), '.ssh');
      if (!fs.existsSync(sshDir)) {
        fs.mkdirSync(sshDir, { mode: 0o700 });
      }

      if (stagingKey) {
        const stagingPath = path.join(sshDir, 'staging_deploy_key');
        fs.writeFileSync(stagingPath, stagingKey, { mode: 0o600 });
        console.log(`✅ Wrote STAGING_SSH to ${stagingPath}`);
      }

      if (prodKey) {
        const prodPath = path.join(sshDir, 'prod_deploy_key');
        fs.writeFileSync(prodPath, prodKey, { mode: 0o600 });
        console.log(`✅ Wrote PROD_SSH to ${prodPath}`);
      }

      if (!stagingKey && !prodKey) {
        console.log('⚠️  No SSH keys found in vault');
      }
      break;
    }
  }
}

export default secrets;

