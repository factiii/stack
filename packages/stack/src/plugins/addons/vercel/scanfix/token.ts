/**
 * Vercel Token Scanfixes
 *
 * Manages VERCEL_TOKEN in Ansible Vault for API deployments.
 */

import type { Fix } from '../../../../types/index.js';
import type { FactiiiConfig } from '../../../../types/index.js';
import { getDefaultVaultPath } from '../../../../utils/config-helpers.js';

export const fixes: Fix[] = [
  {
    id: 'vercel-token-missing',
    stage: 'secrets',
    severity: 'critical',
    description: 'VERCEL_TOKEN not found in Ansible Vault',
    scan: async (config: FactiiiConfig, rootDir: string) => {
      // Skip only if vercel key is completely absent from stack.yml
      // Note: bare `vercel:` in YAML parses as null, which should still trigger
      if (config.vercel === undefined) return false;

      // Check if VERCEL_TOKEN exists in vault
      const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
      const vault = new AnsibleVaultSecrets({
        vault_path: (config.ansible?.vault_path as string) || getDefaultVaultPath(config),
        vault_password_file: config.ansible?.vault_password_file as string | undefined,
        rootDir,
      });

      try {
        const token = await vault.getSecret('VERCEL_TOKEN');
        return !token;  // No token = problem (true), token exists = no problem (false)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('Integrity check failed') || msg.includes('wrong password')) return false;
        return true;    // Other vault error = assume token is missing
      }
    },
    fix: async (config: FactiiiConfig, rootDir: string) => {
      console.log('   Setting up VERCEL_TOKEN in Ansible Vault...');
      console.log('');
      console.log('   Get your token from: https://vercel.com/account/tokens');
      console.log('   Create a new token with:');
      console.log('   - Scope: Full Account (or specific team)');
      console.log('   - Expiration: No Expiration (or custom)');
      console.log('');

      const { promptForSecret } = await import('../../../../utils/secret-prompts.js');
      const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');

      const vault = new AnsibleVaultSecrets({
        vault_path: (config.ansible?.vault_path as string) || getDefaultVaultPath(config),
        vault_password_file: config.ansible?.vault_password_file as string | undefined,
        rootDir,
      });

      try {
        const token = await promptForSecret('VERCEL_TOKEN', config);
        const result = await vault.setSecret('VERCEL_TOKEN', token);
        if (!result.success) {
          console.log('   [!] Failed to store VERCEL_TOKEN: ' + (result.error ?? 'unknown error'));
          return false;
        }
        console.log('   [OK] VERCEL_TOKEN stored in Ansible Vault');

        // Verify it was actually saved by reading it back
        const verify = await vault.getSecret('VERCEL_TOKEN');
        if (!verify) {
          console.log('   [!] Token was saved but could not be read back from vault');
          console.log('   Check ansible-vault configuration and vault password file');
          return false;
        }
        console.log('   [OK] Verified: token readable from vault');
        return true;
      } catch (e) {
        console.log('   [!] Failed to store VERCEL_TOKEN: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: `
Store VERCEL_TOKEN in Ansible Vault manually:

  npx stack deploy --secrets set VERCEL_TOKEN

Or get token from: https://vercel.com/account/tokens
    `,
  },

  {
    id: 'vercel-token-env-not-set',
    stage: 'dev',
    severity: 'info',
    description: 'VERCEL_TOKEN not available in environment (deployments will read from vault)',
    scan: async (config: FactiiiConfig, _rootDir: string) => {
      // Skip only if vercel key is completely absent from stack.yml
      if (config.vercel === undefined) return false;

      // Token in env = no problem, not in env = info-level issue
      return !process.env.VERCEL_TOKEN;
    },
    fix: null,
    manualFix: `
VERCEL_TOKEN is not required in your environment during development.
It will be automatically read from Ansible Vault during deployment.

If you want to set it in your shell for testing:
  export VERCEL_TOKEN="your-token-here"

Or add to your shell profile (~/.bashrc, ~/.zshrc):
  export VERCEL_TOKEN="$(npx stack deploy --secrets get VERCEL_TOKEN)"
    `,
  },
];
