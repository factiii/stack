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
import { AnsibleVaultSecrets } from '../utils/ansible-vault-secrets.js';
import { promptForSecret, promptForEnvSecret } from '../utils/secret-prompts.js';
import { deploySecrets } from './deploy-secrets.js';
import { loadConfig } from '../utils/config-helpers.js';
import type { SecretsOptions, FactiiiConfig } from '../types/index.js';

export type SecretsAction =
  | 'list'
  | 'set'
  | 'get'
  | 'delete'
  | 'check'
  | 'set-env'
  | 'list-env'
  | 'delete-env'
  | 'deploy'
  | 'write-ssh-keys';

function loadConfigOrThrow(rootDir: string): FactiiiConfig {
  const config = loadConfig(rootDir);
  if (!config || Object.keys(config).length === 0) {
    throw new Error('stack.yml not found. Run: npx stack init');
  }
  return config;
}

function getVaultStore(config: FactiiiConfig, rootDir: string): AnsibleVaultSecrets {
  if (!config.ansible?.vault_path) {
    throw new Error(
      'ansible.vault_path not configured in config. Add:\n' +
      '  ansible:\n' +
      '    vault_path: group_vars/all/vault-YOUR_REPO_NAME.yml\n' +
      '    vault_password_file: .vault_pass  # optional'
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
  const config = loadConfigOrThrow(rootDir);

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
        console.log('      Add with: npx stack deploy --secrets set-env <NAME> --staging');
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
        console.log('      Add with: npx stack deploy --secrets set-env <NAME> --prod');
      }

      // Show missing summary
      const allMissing = [...(sshResult.missing ?? []), ...(awsResult.missing ?? [])];
      if (allMissing.length > 0) {
        console.log(`\nMissing secrets: ${allMissing.join(', ')}`);
        console.log('  Set them with: npx stack deploy --secrets set <name>');
      }

      // Show deploy hint if env vars exist
      if (stagingKeys.length > 0 || prodKeys.length > 0) {
        console.log('\nDeploy secrets to servers:');
        console.log('  npx stack deploy --secrets deploy --staging   # Deploy to staging');
        console.log('  npx stack deploy --secrets deploy --prod      # Deploy to production');
        console.log('  npx stack deploy --secrets deploy --all       # Deploy to all');
      }
      break;
    }

    case 'set': {
      if (!secretName) {
        console.log('[ERROR] Secret name required');
        console.log('Usage: npx stack deploy --secrets set <name>');
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

    case 'get': {
      if (!secretName) {
        console.log('[ERROR] Secret name required');
        console.log('Usage: npx stack deploy --secrets get <name>');
        return;
      }

      const secretValue = await store.getSecret(secretName);
      if (secretValue !== null) {
        // For SSH keys, show truncated; for others show full value
        if (secretName.includes('SSH') && secretValue.includes('PRIVATE KEY')) {
          const lines = secretValue.split('\n');
          console.log(secretName + ':');
          console.log('  ' + (lines[0] ?? ''));
          console.log('  ... (' + lines.length + ' lines)');
          console.log('  ' + (lines[lines.length - 1] ?? lines[lines.length - 2] ?? ''));
        } else {
          console.log(secretName + ': ' + secretValue);
        }
      } else {
        console.log('[!] ' + secretName + ' not found in vault');
      }
      break;
    }

    case 'delete': {
      if (!secretName) {
        console.log('[ERROR] Secret name required');
        console.log('Usage: npx stack deploy --secrets delete <name>');
        return;
      }

      const deleteResult = await store.deleteSecret(secretName);
      if (deleteResult.success) {
        console.log('[OK] Deleted ' + secretName + ' from vault');
      } else {
        console.log('[ERROR] ' + (deleteResult.error ?? 'Failed to delete'));
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
        console.log('Usage: npx stack deploy --secrets set-env <NAME> --staging|--prod');
        console.log('');
        console.log('Examples:');
        console.log('   npx stack deploy --secrets set-env DATABASE_URL --staging');
        console.log('   npx stack deploy --secrets set-env JWT_SECRET --prod');
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
        console.log(`Deploy with: npx stack deploy --secrets deploy --${stage}`);
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
          console.log(`\nAdd with: npx stack deploy --secrets set-env <NAME> --${stage}`);
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

    case 'delete-env': {
      if (!secretName) {
        console.log('[ERROR] Environment variable name required');
        console.log('Usage: npx stack deploy --secrets delete-env <NAME> --staging|--prod');
        return;
      }

      let deleteEnvStage: 'staging' | 'prod';
      if (options.staging) {
        deleteEnvStage = 'staging';
      } else if (options.prod) {
        deleteEnvStage = 'prod';
      } else {
        console.log('[ERROR] Please specify --staging or --prod');
        return;
      }

      const deleteEnvResult = await store.deleteEnvironmentSecret(deleteEnvStage, secretName);
      if (deleteEnvResult.success) {
        console.log('[OK] Deleted ' + secretName + ' from ' + deleteEnvStage + ' environment');
        console.log('Deploy with: npx stack deploy --secrets deploy --' + deleteEnvStage);
      } else {
        console.log('[ERROR] ' + (deleteEnvResult.error ?? 'Failed to delete'));
      }
      break;
    }

    case 'write-ssh-keys': {
      const stagingKey = await store.getSecret('STAGING_SSH');
      const prodKey = await store.getSecret('PROD_SSH');
      const keyRepoName = config.name;
      const hasRepoName = keyRepoName && !keyRepoName.toUpperCase().startsWith('EXAMPLE');

      const sshDir = path.join(os.homedir(), '.ssh');
      if (!fs.existsSync(sshDir)) {
        fs.mkdirSync(sshDir, { mode: 0o700 });
      }

      if (stagingKey) {
        // Write generic key (backward compat)
        const genericPath = path.join(sshDir, 'staging_deploy_key');
        fs.writeFileSync(genericPath, stagingKey, { mode: 0o600 });
        console.log(`[OK] Wrote STAGING_SSH to ${genericPath}`);

        // Write repo-specific key
        if (hasRepoName) {
          const repoPath = path.join(sshDir, 'staging_deploy_key_' + keyRepoName);
          fs.writeFileSync(repoPath, stagingKey, { mode: 0o600 });
          console.log(`[OK] Wrote STAGING_SSH to ${repoPath}`);
        }
      }

      if (prodKey) {
        // Write generic key (backward compat)
        const genericPath = path.join(sshDir, 'prod_deploy_key');
        fs.writeFileSync(genericPath, prodKey, { mode: 0o600 });
        console.log(`[OK] Wrote PROD_SSH to ${genericPath}`);

        // Write repo-specific key
        if (hasRepoName) {
          const repoPath = path.join(sshDir, 'prod_deploy_key_' + keyRepoName);
          fs.writeFileSync(repoPath, prodKey, { mode: 0o600 });
          console.log(`[OK] Wrote PROD_SSH to ${repoPath}`);
        }
      }

      if (!stagingKey && !prodKey) {
        console.log('[!] No SSH keys found in vault');
      }
      break;
    }
  }
}

/**
 * Interactive secrets management — shows all secrets and lets user pick action.
 * Called by `npx stack secrets` (no arguments).
 */
export async function secretsInteractive(options: SecretsOptions = {}): Promise<void> {
  const { promptSingleLine } = await import('../utils/secret-prompts.js');
  const rootDir = options.rootDir ?? process.cwd();
  const config = loadConfigOrThrow(rootDir);
  const store = getVaultStore(config, rootDir);

  // Gather all secrets
  const sshSecrets = ['STAGING_SSH', 'PROD_SSH'];
  const awsSecrets = ['AWS_SECRET_ACCESS_KEY'];
  const sshResult = await store.checkSecrets(sshSecrets);
  const awsResult = await store.checkSecrets(awsSecrets);
  const stagingKeys = await store.listEnvironmentSecretKeys('staging');
  const prodKeys = await store.listEnvironmentSecretKeys('prod');

  // Build numbered list
  const allItems: { name: string; type: string; stage?: string; exists: boolean }[] = [];

  for (const name of sshSecrets) {
    allItems.push({ name, type: 'secret', exists: sshResult.status?.[name] ?? false });
  }
  for (const name of awsSecrets) {
    allItems.push({ name, type: 'secret', exists: awsResult.status?.[name] ?? false });
  }
  for (const key of stagingKeys) {
    allItems.push({ name: key, type: 'env', stage: 'staging', exists: true });
  }
  for (const key of prodKeys) {
    allItems.push({ name: key, type: 'env', stage: 'prod', exists: true });
  }

  // Display
  console.log('');
  console.log('ANSIBLE VAULT SECRETS');
  console.log('');

  let idx = 1;
  console.log('  SSH KEYS & CREDENTIALS:');
  for (const item of allItems) {
    if (item.type !== 'secret') continue;
    const marker = item.exists ? '[OK]' : '[! ]';
    console.log('    ' + idx + '. ' + marker + ' ' + item.name);
    idx++;
  }

  if (stagingKeys.length > 0) {
    console.log('');
    console.log('  STAGING ENV VARS:');
    for (const item of allItems) {
      if (item.type !== 'env' || item.stage !== 'staging') continue;
      console.log('    ' + idx + '. [OK] ' + item.name);
      idx++;
    }
  }

  if (prodKeys.length > 0) {
    console.log('');
    console.log('  PROD ENV VARS:');
    for (const item of allItems) {
      if (item.type !== 'env' || item.stage !== 'prod') continue;
      console.log('    ' + idx + '. [OK] ' + item.name);
      idx++;
    }
  }

  console.log('');
  console.log('  Actions:');
  console.log('    [number]        → edit/set that secret');
  console.log('    d[number]       → delete (e.g. d3)');
  console.log('    v[number]       → view value (e.g. v1)');
  console.log('    n               → add new secret');
  console.log('    ne --staging    → add new env var');
  console.log('    q               → quit');
  console.log('');

  const answer = await promptSingleLine('  Select: ');
  if (!answer || answer.toLowerCase() === 'q') return;

  // Parse action
  const trimmed = answer.trim().toLowerCase();

  // "n" = new secret
  if (trimmed === 'n') {
    const name = await promptSingleLine('  Secret name (e.g. STAGING_SSH, AWS_SECRET_ACCESS_KEY): ');
    if (name) {
      await secrets('set', name.trim(), options);
    }
    return;
  }

  // "ne" = new env var
  if (trimmed === 'ne') {
    let stage: 'staging' | 'prod';
    if (options.staging) {
      stage = 'staging';
    } else if (options.prod) {
      stage = 'prod';
    } else {
      const stageAnswer = await promptSingleLine('  Stage (staging/prod): ');
      if (stageAnswer?.trim().toLowerCase() === 'prod') {
        stage = 'prod';
      } else {
        stage = 'staging';
      }
    }
    const envName = await promptSingleLine('  Env var name (e.g. DATABASE_URL): ');
    if (envName) {
      await secrets('set-env', envName.trim(), { ...options, staging: stage === 'staging', prod: stage === 'prod' });
    }
    return;
  }

  // Parse number-based actions: "3" = edit #3, "d3" = delete #3, "v3" = view #3
  let action: 'set' | 'delete' | 'get' = 'set';
  let numStr = trimmed;

  if (trimmed.startsWith('d')) {
    action = 'delete';
    numStr = trimmed.slice(1);
  } else if (trimmed.startsWith('v')) {
    action = 'get';
    numStr = trimmed.slice(1);
  }

  const num = parseInt(numStr, 10);
  if (isNaN(num) || num < 1 || num > allItems.length) {
    console.log('[!] Invalid selection');
    return;
  }

  const selected = allItems[num - 1]!;

  if (selected.type === 'env' && selected.stage) {
    // Environment variable
    const stageOpts = { ...options, staging: selected.stage === 'staging', prod: selected.stage === 'prod' };
    if (action === 'delete') {
      await secrets('delete-env', selected.name, stageOpts);
    } else if (action === 'get') {
      // Get env var value from vault
      const envSecrets = await store.getEnvironmentSecrets(selected.stage as 'staging' | 'prod');
      const val = envSecrets[selected.name];
      if (val !== undefined) {
        console.log(selected.name + '=' + val);
      } else {
        console.log('[!] ' + selected.name + ' not found');
      }
    } else {
      await secrets('set-env', selected.name, stageOpts);
    }
  } else {
    // Top-level secret
    if (action === 'delete') {
      await secrets('delete', selected.name, options);
    } else if (action === 'get') {
      await secrets('get', selected.name, options);
    } else {
      await secrets('set', selected.name, options);
    }
  }
}

export default secrets;
