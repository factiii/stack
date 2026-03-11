/**
 * Vault Scanfixes
 *
 * Detects and fixes Ansible Vault infrastructure:
 * - group_vars/all/ directory
 * - Encrypted vault file (group_vars/all/vault.yml)
 * - Vault password mismatch (existing vault encrypted with different password)
 *
 * Note: Vault password file check is in secrets.ts (missing-vault-password-file)
 * which reads the path from config.ansible.vault_password_file.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { getDefaultVaultPath, hasEnvironments } from '../../../../utils/config-helpers.js';
import { promptSingleLine } from '../../../../utils/secret-prompts.js';

export const vaultFixes: Fix[] = [
  {
    id: 'group-vars-missing',
    stage: 'secrets',
    severity: 'critical',
    description: '📁 group_vars/all/ directory not found',
    scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      if (!hasEnvironments(_config)) return false;
      return !fs.existsSync(path.join(rootDir, 'group_vars', 'all'));
    },
    fix: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      fs.mkdirSync(path.join(rootDir, 'group_vars', 'all'), { recursive: true });
      return true;
    },
    manualFix: 'Run: mkdir -p group_vars/all',
  },

  {
    id: 'vault-file-missing',
    stage: 'secrets',
    severity: 'critical',
    description: '🔐 Encrypted vault file not found',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      if (!hasEnvironments(config)) return false;
      // Only flag if vault password file exists (can't create vault without it)
      if (!config.ansible?.vault_password_file) return false;
      const passFile = config.ansible.vault_password_file.replace(/^~/, os.homedir());
      if (!fs.existsSync(passFile)) return false;
      const vaultPath = config.ansible?.vault_path ?? getDefaultVaultPath(config);
      return !fs.existsSync(path.join(rootDir, vaultPath));
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      try {
        const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
        const vault = new AnsibleVaultSecrets({
          vault_path: config.ansible?.vault_path ?? getDefaultVaultPath(config),
          vault_password_file: config.ansible?.vault_password_file ?? '~/.vault_pass',
          rootDir,
        });
        await vault.setSecret('_initialized', 'true');
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: npx stack fix --secrets',
  },

  {
    id: 'vault-password-mismatch',
    stage: 'secrets',
    severity: 'critical',
    description: '🔐 Vault password does not match existing vault file',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      if (!hasEnvironments(config)) return false;
      // Only check if both vault file and password file exist
      if (!config.ansible?.vault_password_file) return false;
      const passFile = config.ansible.vault_password_file.replace(/^~/, os.homedir());
      if (!fs.existsSync(passFile)) return false;

      const vaultPath = config.ansible?.vault_path ?? getDefaultVaultPath(config);
      const fullVaultPath = path.isAbsolute(vaultPath)
        ? vaultPath
        : path.join(rootDir, vaultPath);
      if (!fs.existsSync(fullVaultPath)) return false;

      // Try to decrypt — if it fails with integrity check, password is wrong
      try {
        const { getVaultPasswordString } = await import('../../../../utils/ansible-vault-secrets.js');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Vault } = require('ansible-vault') as { Vault: new (opts: { password: string }) => { decryptSync: (data: string) => string } };

        const password = getVaultPasswordString({
          vault_path: vaultPath,
          vault_password_file: config.ansible.vault_password_file,
          rootDir,
        });

        const vaultContent = fs.readFileSync(fullVaultPath, 'utf8')
          .replace(/^\uFEFF/, '')
          .trim();
        const v = new Vault({ password });
        v.decryptSync(vaultContent);
        return false; // Decryption succeeded — no mismatch
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('Integrity check failed') || msg.includes('wrong password')) {
          return true; // Password mismatch detected
        }
        // Other errors (file not found, etc.) — not a mismatch
        return false;
      }
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const vaultPath = config.ansible?.vault_path ?? getDefaultVaultPath(config);
      const fullVaultPath = path.isAbsolute(vaultPath)
        ? vaultPath
        : path.join(rootDir, vaultPath);

      console.log('');
      console.log('   ⚠️  Vault password mismatch detected!');
      console.log('   The vault file was encrypted with a different password than ~/.vault_pass');
      console.log('');
      console.log('   Options:');
      console.log('   1. Recreate vault with current password (existing secrets will be lost)');
      console.log('   2. Update ~/.vault_pass with the original password');
      console.log('');

      const choice = await promptSingleLine('   Choose (1 or 2): ');

      if (choice === '2') {
        // User wants to update password file
        const passFile = (config.ansible?.vault_password_file ?? '~/.vault_pass')
          .replace(/^~/, os.homedir());
        console.log('');
        const newPass = await promptSingleLine('   Enter the original vault password: ', { hidden: true });
        if (!newPass) {
          console.log('   No password entered');
          return false;
        }

        // Verify it works before writing
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { Vault } = require('ansible-vault') as { Vault: new (opts: { password: string }) => { decryptSync: (data: string) => string } };
          const vaultContent = fs.readFileSync(fullVaultPath, 'utf8')
            .replace(/^\uFEFF/, '')
            .trim();
          const v = new Vault({ password: newPass });
          v.decryptSync(vaultContent);

          // Success — write the password
          fs.writeFileSync(passFile, newPass + '\n', { mode: 0o600 });
          console.log('   [OK] Updated ' + passFile + ' with correct password');
          return true;
        } catch {
          console.log('   [!] That password also failed — vault may be corrupted');
          return false;
        }
      }

      if (choice === '1') {
        // Recreate vault with current password
        const backupPath = fullVaultPath + '.bak.' + Date.now();
        try {
          fs.copyFileSync(fullVaultPath, backupPath);
          console.log('   Backed up old vault → ' + backupPath);
        } catch {
          // Continue even if backup fails
        }

        try {
          // Delete old vault and create fresh one
          fs.unlinkSync(fullVaultPath);

          const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
          const vault = new AnsibleVaultSecrets({
            vault_path: vaultPath,
            vault_password_file: config.ansible?.vault_password_file ?? '~/.vault_pass',
            rootDir,
          });
          await vault.setSecret('_initialized', 'true');
          console.log('   [OK] Created new vault with current password');
          return true;
        } catch (e) {
          console.log('   [!] Failed to create new vault: ' + (e instanceof Error ? e.message : String(e)));
          return false;
        }
      }

      console.log('   Invalid choice');
      return false;
    },
    manualFix:
      'Vault was created with a different password.\n' +
      '      Option 1: Delete the vault file and re-run: npx stack fix --secrets\n' +
      '      Option 2: Copy the original ~/.vault_pass from the machine that created the vault',
  },
];
