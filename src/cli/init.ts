/**
 * Init Command
 *
 * Initializes factiii.yml in a project
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';
import { generateFactiiiYml } from '../generators/generate-factiii-yml.js';
import { generateFactiiiAuto } from '../generators/generate-factiii-auto.js';
import { confirm, promptSingleLine } from '../utils/secret-prompts.js';
import type { InitOptions } from '../types/index.js';

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

export async function init(options: InitOptions = {}): Promise<void> {
  const rootDir = options.rootDir ?? process.cwd();

  console.log('Initializing Factiii Stack...\n');

  const factiiiYmlPath = path.join(rootDir, 'factiii.yml');
  const factiiiAutoYmlPath = path.join(rootDir, 'factiiiAuto.yml');

  // Check if files exist and prompt if not using --force
  let shouldCreateYml = options.force ?? false;
  let shouldCreateAuto = options.force ?? false;

  if (!fs.existsSync(factiiiYmlPath)) {
    shouldCreateYml = true;  // File doesn't exist, create it
  } else if (!options.force) {
    shouldCreateYml = await confirm('factiii.yml already exists. Overwrite it?', false);
    if (!shouldCreateYml) {
      console.log('Skipping factiii.yml');
    }
  }

  if (!fs.existsSync(factiiiAutoYmlPath)) {
    shouldCreateAuto = true;  // File doesn't exist, create it
  } else if (!options.force) {
    shouldCreateAuto = await confirm('factiiiAuto.yml already exists. Overwrite it?', false);
    if (!shouldCreateAuto) {
      console.log('Skipping factiiiAuto.yml');
    }
  }

  // Generate factiii.yml
  if (shouldCreateYml) {
    const created = generateFactiiiYml(rootDir, { force: true });
    if (created) {
      // Generate factiiiAuto.yml (always update if yml was created/updated)
      await generateFactiiiAuto(rootDir, { force: shouldCreateAuto });
    }
  } else {
    // factiii.yml not created, but check if we should update factiiiAuto.yml
    if (shouldCreateAuto) {
      await generateFactiiiAuto(rootDir, { force: true });
    } else if (fs.existsSync(factiiiYmlPath)) {
      // factiii.yml exists and wasn't overwritten, but auto might need updating
      // (factiiiAuto.yml is auto-detected, so update if content changed)
      await generateFactiiiAuto(rootDir, { force: false });
    } else {
      console.log('\nNo configuration files to create.');
    }
  }

  // Check prerequisites
  console.log('\nChecking prerequisites...\n');

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
  }

  // Vault setup (only if ansible is available and we created a new config)
  if (hasAnsibleVault && shouldCreateYml) {
    const vaultPassFile = path.join(os.homedir(), '.vault_pass');
    const hasExistingVaultPass = fs.existsSync(vaultPassFile);

    if (hasExistingVaultPass) {
      console.log('  [OK] Vault password file exists at ' + vaultPassFile);
    } else {
      console.log('');
      const setupVault = await confirm('Set up Ansible Vault for secrets now?', true);

      if (setupVault) {
        console.log('\n  Create a vault password (keep this safe - you need it to access secrets):');
        const vaultPassword = await promptSingleLine('  Vault password: ');

        if (vaultPassword && vaultPassword.trim().length > 0) {
          // Write vault password file
          fs.writeFileSync(vaultPassFile, vaultPassword.trim(), 'utf8');
          try {
            fs.chmodSync(vaultPassFile, 0o600);
          } catch {
            // Windows doesn't support chmod - that's OK
          }
          console.log('  [OK] Vault password saved to ' + vaultPassFile);

          // Create group_vars/all/ directory
          const groupVarsDir = path.join(rootDir, 'group_vars', 'all');
          if (!fs.existsSync(groupVarsDir)) {
            fs.mkdirSync(groupVarsDir, { recursive: true });
            console.log('  [OK] Created ' + groupVarsDir);
          }

          // Initialize vault file
          try {
            const { AnsibleVaultSecrets } = await import('../utils/ansible-vault-secrets.js');
            const vault = new AnsibleVaultSecrets({
              vault_path: 'group_vars/all/vault.yml',
              vault_password_file: '~/.vault_pass',
              rootDir,
            });
            await vault.setSecret('_initialized', 'true');
            console.log('  [OK] Created encrypted vault at group_vars/all/vault.yml');
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.log('  [!] Failed to create vault: ' + msg);
            console.log('      You can set it up later with: npx factiii secrets set <KEY>');
          }
        } else {
          console.log('  [!] Skipped vault setup (no password provided)');
        }
      } else {
        console.log('  [!] Skipped vault setup. Set up later:');
        console.log('      1. Create vault password: echo "your-password" > ~/.vault_pass');
        console.log('      2. Store a secret: npx factiii secrets set STAGING_SSH');
      }
    }
  }

  console.log('');
}

export default init;
