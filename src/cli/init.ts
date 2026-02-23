/**
 * Init Command
 *
 * Handles interactive setup that scanfixes cannot do:
 * - Vault password creation (requires user input)
 * - Secret prompting (SSH keys, AWS credentials)
 * - --force flag to regenerate stack.yml from scratch
 *
 * Config file creation (stack.yml, stackAuto.yml, stack.local.yml) and
 * gitignore management are now handled by bootstrap scanfixes in the
 * factiii pipeline plugin. Running `npx stack` will auto-create them.
 */

import * as path from 'path';
import { STACK_CONFIG_FILENAME, getStackConfigPath } from '../constants/config-files.js';
import * as fs from 'fs';
import * as os from 'os';
import yaml from 'js-yaml';
import { execSync } from 'child_process';
import { generateFactiiiYml } from '../generators/generate-stack-yml.js';
import { confirm, promptSingleLine, promptForSecret } from '../utils/secret-prompts.js';
import { extractEnvironments } from '../utils/config-helpers.js';
import type { FactiiiConfig, InitOptions } from '../types/index.js';

/**
 * Check if ansible-vault CLI is available
 */
function checkAnsibleVault(): boolean {
  try {
    execSync('ansible-vault --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure group_vars/all/ directory and encrypted vault file exist.
 * Returns what was fixed (empty array if nothing needed fixing).
 */
async function ensureVaultSetup(rootDir: string, _vaultPassFile: string): Promise<string[]> {
  const fixed: string[] = [];

  const groupVarsDir = path.join(rootDir, 'group_vars', 'all');
  if (!fs.existsSync(groupVarsDir)) {
    fs.mkdirSync(groupVarsDir, { recursive: true });
    fixed.push('Created ' + groupVarsDir);
  }

  const vaultFilePath = path.join(rootDir, 'group_vars', 'all', 'vault.yml');
  if (!fs.existsSync(vaultFilePath)) {
    try {
      const { AnsibleVaultSecrets } = await import('../utils/ansible-vault-secrets.js');
      const vault = new AnsibleVaultSecrets({
        vault_path: 'group_vars/all/vault.yml',
        vault_password_file: '~/.vault_pass',
        rootDir,
      });
      await vault.setSecret('_initialized', 'true');
      fixed.push('Created encrypted vault at group_vars/all/vault.yml');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      fixed.push('Failed to create vault: ' + msg);
    }
  }

  return fixed;
}

/**
 * Extract SSH key from vault to ~/.ssh/{stage}_deploy_key
 * With safety check: asks before overwriting existing key
 */
async function extractSSHKeyToFile(vault: any, stage: 'staging' | 'prod', _rootDir: string): Promise<void> {
  const keyName = stage + '_deploy_key';
  const sshDir = path.join(os.homedir(), '.ssh');
  const keyPath = path.join(sshDir, keyName);

  // Safety check: don't overwrite existing keys without asking
  if (fs.existsSync(keyPath)) {
    const overwrite = await confirm('  SSH key already exists at ' + keyPath + ' - overwrite?', false);
    if (!overwrite) {
      console.log('  [--] Keeping existing key at ' + keyPath);
      return;
    }
  }

  try {
    const key = await vault.getSSHKey(stage);
    if (!key) {
      console.log('  [!] No ' + stage.toUpperCase() + '_SSH key found in vault');
      return;
    }

    if (!fs.existsSync(sshDir)) {
      fs.mkdirSync(sshDir, { recursive: true });
    }

    fs.writeFileSync(keyPath, key, 'utf8');
    try {
      fs.chmodSync(keyPath, 0o600);
    } catch {
      // Windows doesn't support chmod
    }
    console.log('  [OK] Wrote SSH key to ' + keyPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log('  [!] Failed to extract SSH key: ' + msg);
  }
}

/**
 * Load config and prompt for missing secrets (SSH keys, AWS credentials)
 */
async function promptForMissingSecrets(rootDir: string): Promise<void> {
  const configPath = getStackConfigPath(rootDir);
  if (!fs.existsSync(configPath)) return;

  let config: FactiiiConfig;
  try {
    config = (yaml.load(fs.readFileSync(configPath, 'utf8')) as FactiiiConfig) ?? ({} as FactiiiConfig);
  } catch {
    return;
  }

  if (!config.ansible?.vault_path) return;

  const environments = extractEnvironments(config);
  const hasStaging = !!environments.staging;
  const hasProd = !!environments.prod || !!environments.production;
  const hasAWS = Object.values(environments).some(
    (env) => env.pipeline === 'aws' || env.access_key_id
  );

  if (!hasStaging && !hasProd && !hasAWS) return;

  let vault: any;
  try {
    const { AnsibleVaultSecrets } = await import('../utils/ansible-vault-secrets.js');
    vault = new AnsibleVaultSecrets({
      vault_path: config.ansible.vault_path,
      vault_password_file: config.ansible.vault_password_file ?? '~/.vault_pass',
      rootDir,
    });
  } catch {
    return;
  }

  console.log('\n  Checking secrets...\n');

  // Check STAGING_SSH
  if (hasStaging) {
    try {
      const check = await vault.checkSecrets(['STAGING_SSH']);
      if (check.missing.includes('STAGING_SSH')) {
        const addNow = await confirm('  Add staging SSH key now? (skip to do later with: npx stack secrets set STAGING_SSH)', false);
        if (addNow) {
          const value = await promptForSecret('STAGING_SSH', config);
          if (value) {
            await vault.setSecret('STAGING_SSH', value);
            console.log('  [OK] STAGING_SSH stored in vault');
            await extractSSHKeyToFile(vault, 'staging', rootDir);
          }
        } else {
          console.log('  [--] Skipped STAGING_SSH');
        }
      } else {
        console.log('  [OK] STAGING_SSH already in vault');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log('  [!] Could not check STAGING_SSH: ' + msg);
    }
  }

  // Check PROD_SSH
  if (hasProd) {
    try {
      const check = await vault.checkSecrets(['PROD_SSH']);
      if (check.missing.includes('PROD_SSH')) {
        const addNow = await confirm('  Add prod SSH key now? (skip to do later with: npx stack secrets set PROD_SSH)', false);
        if (addNow) {
          const value = await promptForSecret('PROD_SSH', config);
          if (value) {
            await vault.setSecret('PROD_SSH', value);
            console.log('  [OK] PROD_SSH stored in vault');
            await extractSSHKeyToFile(vault, 'prod', rootDir);
          }
        } else {
          console.log('  [--] Skipped PROD_SSH');
        }
      } else {
        console.log('  [OK] PROD_SSH already in vault');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log('  [!] Could not check PROD_SSH: ' + msg);
    }
  }

  // Check AWS_SECRET_ACCESS_KEY
  if (hasAWS) {
    try {
      const check = await vault.checkSecrets(['AWS_SECRET_ACCESS_KEY']);
      if (check.missing.includes('AWS_SECRET_ACCESS_KEY')) {
        const addNow = await confirm('  Add AWS Secret Access Key now?', false);
        if (addNow) {
          const value = await promptForSecret('AWS_SECRET_ACCESS_KEY', config);
          if (value) {
            await vault.setSecret('AWS_SECRET_ACCESS_KEY', value);
            console.log('  [OK] AWS_SECRET_ACCESS_KEY stored in vault');
          }
        } else {
          console.log('  [--] Skipped AWS_SECRET_ACCESS_KEY');
        }
      } else {
        console.log('  [OK] AWS_SECRET_ACCESS_KEY already in vault');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log('  [!] Could not check AWS_SECRET_ACCESS_KEY: ' + msg);
    }
  }
}

export async function init(options: InitOptions = {}): Promise<void> {
  const rootDir = options.rootDir ?? process.cwd();
  const configPath = getStackConfigPath(rootDir);
  const isFirstRun = !fs.existsSync(configPath);

  // If --force, regenerate stack.yml from template
  if (options.force) {
    console.log('Regenerating ' + STACK_CONFIG_FILENAME + '...\n');
    generateFactiiiYml(rootDir, { force: true });
  } else if (isFirstRun) {
    // No stack.yml — tell user to run npx stack (which bootstraps via scanfixes)
    console.log('No ' + STACK_CONFIG_FILENAME + ' found.');
    console.log('Run `npx stack` to auto-detect your project and create config files.\n');
    console.log('Or run `npx stack init --force` to generate from template.\n');
  }

  // Interactive vault and secrets setup
  await setupVaultAndSecrets(rootDir);
}

/**
 * Interactive vault password creation and secret prompting.
 * This is the part that cannot be automated via scanfixes.
 */
async function setupVaultAndSecrets(rootDir: string): Promise<void> {
  console.log('Checking prerequisites...\n');

  const hasAnsibleVault = checkAnsibleVault();
  if (hasAnsibleVault) {
    console.log('  [OK] ansible-vault is installed');
  } else {
    console.log('  [!] ansible-vault not found');
    console.log('      Ansible Vault is required for managing secrets.');
    console.log('      Install:');
    if (process.platform === 'darwin') {
      console.log('        brew install ansible');
    } else if (process.platform === 'win32') {
      console.log('        pip install ansible');
    } else {
      console.log('        sudo apt install ansible  (Debian/Ubuntu)');
      console.log('        sudo yum install ansible  (RHEL/CentOS)');
    }
    return;
  }

  // Vault setup (interactive)
  const vaultPassFile = path.join(os.homedir(), '.vault_pass');
  const hasExistingVaultPass = fs.existsSync(vaultPassFile);

  if (hasExistingVaultPass) {
    console.log('  [OK] Vault password file exists at ' + vaultPassFile);
    // Auto-create vault structure if password exists
    const vaultFixes = await ensureVaultSetup(rootDir, vaultPassFile);
    for (const fix of vaultFixes) {
      console.log('  [OK] ' + fix);
    }
  } else {
    console.log('');
    const setupVault = await confirm('Set up Ansible Vault for secrets now?', true);

    if (setupVault) {
      console.log('\n  Create a vault password (keep this safe - you need it to access secrets):');
      const vaultPassword = await promptSingleLine('  Vault password: ');

      if (vaultPassword && vaultPassword.trim().length > 0) {
        fs.writeFileSync(vaultPassFile, vaultPassword.trim(), 'utf8');
        try {
          fs.chmodSync(vaultPassFile, 0o600);
        } catch {
          // Windows doesn't support chmod - that's OK
        }
        console.log('  [OK] Vault password saved to ' + vaultPassFile);

        const vaultFixes = await ensureVaultSetup(rootDir, vaultPassFile);
        for (const fix of vaultFixes) {
          console.log('  [OK] ' + fix);
        }
      } else {
        console.log('  [!] Skipped vault setup (no password provided)');
      }
    } else {
      console.log('  [!] Skipped vault setup. Set up later:');
      console.log('      1. Create vault password: echo "your-password" > ~/.vault_pass');
      console.log('      2. Store a secret: npx stack secrets set STAGING_SSH');
    }
  }

  // Prompt for missing secrets (SSH keys, AWS credentials)
  await promptForMissingSecrets(rootDir);

  console.log('\n  ────────────────────────────────────────────────');
  console.log('  Config files are managed by `npx stack` (scan/fix).');
  console.log('  This command only handles vault and secrets setup.');
  console.log('  ────────────────────────────────────────────────\n');
}

export default init;
