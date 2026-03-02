/**
 * Vault Scanfixes
 *
 * Detects and fixes Ansible Vault infrastructure:
 * - group_vars/all/ directory
 * - Encrypted vault file (group_vars/all/vault.yml)
 *
 * Note: Vault password file check is in secrets.ts (missing-vault-password-file)
 * which reads the path from config.ansible.vault_password_file.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';

export const vaultFixes: Fix[] = [
  {
    id: 'group-vars-missing',
    stage: 'secrets',
    severity: 'critical',
    description: '📁 group_vars/all/ directory not found',
    scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
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
    description: '🔐 Encrypted vault not found at group_vars/all/vault.yml',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      // Only flag if vault password file exists (can't create vault without it)
      if (!config.ansible?.vault_password_file) return false;
      const passFile = config.ansible.vault_password_file.replace(/^~/, os.homedir());
      if (!fs.existsSync(passFile)) return false;
      return !fs.existsSync(path.join(rootDir, 'group_vars', 'all', 'vault.yml'));
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      try {
        const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
        const vault = new AnsibleVaultSecrets({
          vault_path: config.ansible?.vault_path ?? 'group_vars/all/vault.yml',
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
];
