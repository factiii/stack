/**
 * Secrets Command
 *
 * Manages secrets via Ansible Vault.
 * 
 * Actions:
 *   list       - List all secrets (SSH keys + env vars)
 *   set        - Set a secret (SSH keys, AWS credentials)
 *   check      - Check if secrets exist
 *   set-env    - Set environment variable for a stage
 *   list-env   - List environment variable keys for a stage
 *   deploy     - Deploy secrets to staging/prod servers
 *   write-ssh-keys - Write SSH keys to ~/.ssh/ (for workflows)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import yaml from 'js-yaml';
import { AnsibleVaultSecrets } from '../utils/ansible-vault-secrets.js';
import { promptForSecret, promptForEnvSecret } from '../utils/secret-prompts.js';
import { deploySecrets } from './deploy-secrets.js';
import type { SecretsOptions, FactiiiConfig } from '../types/index.js';

export type SecretsAction =
  | 'list'
  | 'set'
  | 'check'
  | 'set-env'
  | 'list-env'
  | 'deploy'
  | 'write-ssh-keys';

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

function getVaultStore(config: FactiiiConfig, rootDir: string): AnsibleVaultSecrets {
  if (!config.ansible?.vault_path) {
    throw new Error(
      'ansible.vault_path not configured in factiii.yml. Add:\n' +
      '  ansible:\n' +
      '    vault_path: group_vars/all/vault.yml\n' +
      '    vault_password_file: ~/.vault_pass  # optional'
    );
  }

  return new AnsibleVaultSecrets({
    vault_path: config.ansible.vault_path,
    vault_password_file: config.ansible.vault_password_file,
    rootDir,
  });
}

export async function secrets(
  action: SecretsAction,
  secretName?: string,
  options: SecretsOptions = {}
): Promise<void> {
  const rootDir = options.rootDir ?? process.cwd();
  const config = loadConfig(rootDir);

  // Handle deploy action separately (uses different parameters)
  if (action === 'deploy') {
    let environment: 'staging' | 'prod' | 'all' = 'all';
    if (options.staging) environment = 'staging';
    if (options.prod) environment = 'prod';

    const result = await deploySecrets(environment, {
      rootDir,
      restart: options.restart,
      dryRun: options.dryRun,
    });

    if (!result.success) {
      process.exit(1);
    }
    return;
  }

  const store = getVaultStore(config, rootDir);

  switch (action) {
    case 'list': {
      console.log('ANSIBLE VAULT SECRETS\n');

      // Check SSH keys
      console.log('SSH KEYS:');
      const sshSecrets = ['STAGING_SSH', 'PROD_SSH'];
      const sshResult = await store.checkSecrets(sshSecrets);
      for (const name of sshSecrets) {
        const exists = sshResult.status?.[name] ?? false;
        const marker = exists ? '[OK]' : '[!]';
        const status = exists ? 'exists' : 'missing';
        console.log(`  ${marker} ${name}: ${status}`);
      }

      // Check AWS credentials
      console.log('\nAWS CREDENTIALS:');
      const awsSecrets = ['AWS_SECRET_ACCESS_KEY'];
      const awsResult = await store.checkSecrets(awsSecrets);
      for (const name of awsSecrets) {
        const exists = awsResult.status?.[name] ?? false;
        const marker = exists ? '[OK]' : '[!]';
        const status = exists ? 'exists' : 'missing';
        console.log(`  ${marker} ${name}: ${status}`);
      }

      // Check staging environment secrets
      console.log('\nSTAGING ENVIRONMENT:');
      const stagingKeys = await store.listEnvironmentSecretKeys('staging');
      if (stagingKeys.length > 0) {
        for (const key of stagingKeys) {
          console.log(`  [OK] ${key}`);
        }
      } else {
        console.log('  [!] No environment variables set');
        console.log('      Add with: npx factiii secrets set-env <NAME> --staging');
      }

      // Check prod environment secrets
      console.log('\nPRODUCTION ENVIRONMENT:');
      const prodKeys = await store.listEnvironmentSecretKeys('prod');
      if (prodKeys.length > 0) {
        for (const key of prodKeys) {
          console.log(`  [OK] ${key}`);
        }
      } else {
        console.log('  [!] No environment variables set');
        console.log('      Add with: npx factiii secrets set-env <NAME> --prod');
      }

      // Show missing summary
      const allMissing = [...(sshResult.missing ?? []), ...(awsResult.missing ?? [])];
      if (allMissing.length > 0) {
        console.log(`\nMissing secrets: ${allMissing.join(', ')}`);
        console.log('  Set them with: npx factiii secrets set <name>');
      }

      // Show deploy hint if env vars exist
      if (stagingKeys.length > 0 || prodKeys.length > 0) {
        console.log('\nDeploy secrets to servers:');
        console.log('  npx factiii secrets deploy --staging   # Deploy to staging');
        console.log('  npx factiii secrets deploy --prod      # Deploy to production');
        console.log('  npx factiii secrets deploy --all       # Deploy to all');
      }
      break;
    }

    case 'set': {
      if (!secretName) {
        console.log('[ERROR] Secret name required');
        console.log('Usage: npx factiii secrets set <name>');
        console.log('');
        console.log('Available secrets:');
        console.log('   STAGING_SSH          - SSH private key for staging');
        console.log('   PROD_SSH             - SSH private key for production');
        console.log('   AWS_SECRET_ACCESS_KEY - AWS secret access key');
        return;
      }

      let value = options.value;
      if (!value) {
        value = await promptForSecret(secretName, config);
      }

      console.log(`\nSetting ${secretName} in Ansible Vault...`);
      const result = await store.setSecret(secretName, value);

      if (result.success) {
        console.log(`[OK] ${secretName} set successfully in ${config.ansible?.vault_path}`);
      } else {
        console.log(`[ERROR] Failed to set ${secretName}: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'check': {
      const secretNames = secretName ? [secretName] : ['STAGING_SSH', 'PROD_SSH', 'AWS_SECRET_ACCESS_KEY'];
      const result = await store.checkSecrets(secretNames);

      if (result.error) {
        console.log(`[ERROR] ${result.error}`);
        return;
      }

      for (const name of secretNames) {
        const exists = result.status?.[name] ?? false;
        console.log(`${exists ? '[OK]' : '[!]'} ${name}`);
      }
      break;
    }

    case 'set-env': {
      if (!secretName) {
        console.log('[ERROR] Environment variable name required');
        console.log('Usage: npx factiii secrets set-env <NAME> --staging|--prod');
        console.log('');
        console.log('Examples:');
        console.log('   npx factiii secrets set-env DATABASE_URL --staging');
        console.log('   npx factiii secrets set-env JWT_SECRET --prod');
        return;
      }

      // Determine stage from options
      let stage: 'staging' | 'prod';
      if (options.staging) {
        stage = 'staging';
      } else if (options.prod) {
        stage = 'prod';
      } else {
        console.log('[ERROR] Please specify --staging or --prod');
        return;
      }

      let value = options.value;
      if (!value) {
        value = await promptForEnvSecret(secretName, stage);
      }

      console.log(`\nSetting ${secretName} for ${stage} in Ansible Vault...`);
      const result = await store.setEnvironmentSecret(stage, secretName, value as string);

      if (result.success) {
        console.log(`[OK] ${secretName} set successfully for ${stage}`);
        console.log(`Deploy with: npx factiii secrets deploy --${stage}`);
      } else {
        console.log(`[ERROR] Failed to set ${secretName}: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'list-env': {
      // Determine stage from options
      let stage: 'staging' | 'prod' | undefined;
      if (options.staging) {
        stage = 'staging';
      } else if (options.prod) {
        stage = 'prod';
      }

      if (stage) {
        console.log(`\nEnvironment variables for ${stage}:`);
        const keys = await store.listEnvironmentSecretKeys(stage);
        if (keys.length > 0) {
          for (const key of keys) {
            console.log(`  - ${key}`);
          }
        } else {
          console.log('   (none)');
          console.log(`\nAdd with: npx factiii secrets set-env <NAME> --${stage}`);
        }
      } else {
        // List both
        console.log('\nSTAGING Environment Variables:');
        const stagingKeys = await store.listEnvironmentSecretKeys('staging');
        if (stagingKeys.length > 0) {
          for (const key of stagingKeys) {
            console.log(`  - ${key}`);
          }
        } else {
          console.log('   (none)');
        }

        console.log('\nPRODUCTION Environment Variables:');
        const prodKeys = await store.listEnvironmentSecretKeys('prod');
        if (prodKeys.length > 0) {
          for (const key of prodKeys) {
            console.log(`  - ${key}`);
          }
        } else {
          console.log('   (none)');
        }
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
        console.log(`[OK] Wrote STAGING_SSH to ${stagingPath}`);
      }

      if (prodKey) {
        const prodPath = path.join(sshDir, 'prod_deploy_key');
        fs.writeFileSync(prodPath, prodKey, { mode: 0o600 });
        console.log(`[OK] Wrote PROD_SSH to ${prodPath}`);
      }

      if (!stagingKey && !prodKey) {
        console.log('[!] No SSH keys found in vault');
      }
      break;
    }
  }
}

export default secrets;


