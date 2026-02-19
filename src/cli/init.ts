/**
 * Init Command
 *
 * First run: creates configs, sets up vault, explains what future runs will auto-fix.
 * Subsequent runs: auto-fixes everything without prompts.
 * Use --force to regenerate stack.yml from scratch.
 */

import * as path from 'path';
import { STACK_CONFIG_FILENAME, STACK_AUTO_FILENAME, getStackConfigPath, getStackAutoPath } from '../constants/config-files.js';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';
import { generateFactiiiYml } from '../generators/generate-stack-yml.js';
import { generateFactiiiAuto } from '../generators/generate-stack-auto.js';
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

/**
 * Ensure group_vars/all/ directory and encrypted vault file exist.
 * Returns what was fixed (empty array if nothing needed fixing).
 */
async function ensureVaultSetup(rootDir: string, vaultPassFile: string): Promise<string[]> {
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

export async function init(options: InitOptions = {}): Promise<void> {
  const rootDir = options.rootDir ?? process.cwd();
  const configPath = getStackConfigPath(rootDir);
  const isFirstRun = !fs.existsSync(configPath);

  if (isFirstRun || options.force) {
    await firstRun(rootDir, options);
  } else {
    await autoFix(rootDir);
  }
}

/**
 * First run: create configs, set up vault, explain what future runs will do.
 */
async function firstRun(rootDir: string, options: InitOptions): Promise<void> {
  console.log('Initializing Factiii Stack...\n');

  // Generate stack.yml
  const created = generateFactiiiYml(rootDir, { force: true });
  if (created) {
    await generateFactiiiAuto(rootDir, { force: true });
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

  // Vault setup (interactive, first time only)
  if (hasAnsibleVault) {
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
  }

  // Tell the user what future runs will auto-fix
  console.log('\n  ────────────────────────────────────────────────');
  console.log('  From now on, running `npx stack init` will auto-fix:');
  console.log('    - Refresh auto-detected config (' + STACK_AUTO_FILENAME + ')');
  console.log('    - Verify prerequisites (ansible-vault)');
  console.log('    - Repair vault directory and files if missing');
  console.log('    - Use --force to regenerate ' + STACK_CONFIG_FILENAME + ' from scratch');
  console.log('  ────────────────────────────────────────────────\n');
}

/**
 * Subsequent runs: auto-fix everything without prompts.
 * Only reports what was actually changed.
 */
async function autoFix(rootDir: string): Promise<void> {
  const fixed: string[] = [];

  // Always refresh auto-detected config
  const autoPath = getStackAutoPath(rootDir);
  const oldAutoContent = fs.existsSync(autoPath)
    ? fs.readFileSync(autoPath, 'utf8')
    : '';
  await generateFactiiiAuto(rootDir, { force: true });
  const newAutoPath = getStackAutoPath(rootDir);
  const newAutoContent = fs.existsSync(newAutoPath)
    ? fs.readFileSync(newAutoPath, 'utf8')
    : '';
  if (oldAutoContent !== newAutoContent) {
    fixed.push('Updated auto config with latest detection');
  }

  // Check prerequisites
  const hasAnsibleVault = checkAnsibleVault();
  if (!hasAnsibleVault) {
    fixed.push('ansible-vault not found - install it to manage secrets');
  }

  // Auto-repair vault setup if vault password exists
  if (hasAnsibleVault) {
    const vaultPassFile = path.join(os.homedir(), '.vault_pass');
    if (fs.existsSync(vaultPassFile)) {
      const vaultFixes = await ensureVaultSetup(rootDir, vaultPassFile);
      fixed.push(...vaultFixes);
    }
  }

  // Report results
  if (fixed.length === 0) {
    console.log('Everything up to date.');
  } else {
    console.log('Auto-fixed:\n');
    for (const fix of fixed) {
      console.log('  [OK] ' + fix);
    }
    console.log('');
  }
}

export default init;
