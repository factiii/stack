/**
 * Auth Secrets Scanfixes
 *
 * Manages authentication secrets in Ansible Vault:
 * - JWT_SECRET: auto-generated 256-bit random key
 * - OAuth keys: prompted from user (Google, Apple)
 */

import * as crypto from 'crypto';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { getDefaultVaultPath } from '../../../../utils/config-helpers.js';

/**
 * Get auth config from FactiiiConfig (handles undefined/null)
 */
function getAuthConfig(config: FactiiiConfig): Record<string, unknown> | null {
  const auth = (config as Record<string, unknown>).auth;
  if (!auth || typeof auth !== 'object') return null;
  return auth as Record<string, unknown>;
}

/**
 * Check if OAuth is enabled for a specific provider
 */
function isOAuthEnabled(config: FactiiiConfig, provider: 'google' | 'apple'): boolean {
  const auth = getAuthConfig(config);
  if (!auth) return false;

  // Check auth.features.oauth
  const features = auth.features as Record<string, unknown> | undefined;
  if (features?.oauth) return true;

  // Check auth.oauth_provider
  if (auth.oauth_provider === provider) return true;

  return false;
}

/**
 * Get Ansible Vault store
 */
async function getVault(config: FactiiiConfig, rootDir: string) {
  const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
  return new AnsibleVaultSecrets({
    vault_path: config.ansible?.vault_path ?? getDefaultVaultPath(config),
    vault_password_file: config.ansible?.vault_password_file,
    rootDir,
  });
}

export const secretsFixes: Fix[] = [
  {
    id: 'auth-jwt-secret-missing',
    stage: 'secrets',
    severity: 'critical',
    description: 'JWT_SECRET not found in Ansible Vault (required for auth)',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      try {
        const vault = await getVault(config, rootDir);
        const secret = await vault.getSecret('JWT_SECRET');
        return !secret;
      } catch {
        return false; // Vault not available, skip
      }
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      try {
        const vault = await getVault(config, rootDir);

        // Auto-generate a cryptographically secure 256-bit secret
        const jwtSecret = crypto.randomBytes(32).toString('hex');
        const result = await vault.setSecret('JWT_SECRET', jwtSecret);

        if (result.success) {
          console.log('   [OK] Generated and stored JWT_SECRET in Ansible Vault');
          console.log('   (256-bit random key, no manual input needed)');
          return true;
        }

        console.log('   Failed to store JWT_SECRET in vault');
        return false;
      } catch (e) {
        console.log('   Error: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Generate and store JWT secret: npx stack deploy --secrets set JWT_SECRET',
  },

  {
    id: 'auth-oauth-google-missing',
    stage: 'secrets',
    severity: 'warning',
    description: 'Google OAuth credentials not in vault (GOOGLE_CLIENT_ID)',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      if (!isOAuthEnabled(config, 'google')) return false;

      try {
        const vault = await getVault(config, rootDir);
        const clientId = await vault.getSecret('GOOGLE_CLIENT_ID');
        return !clientId;
      } catch {
        return false;
      }
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      try {
        const { promptForSecret } = await import('../../../../utils/secret-prompts.js');
        const vault = await getVault(config, rootDir);

        console.log('');
        console.log('   Google OAuth Setup');
        console.log('   Get credentials from: https://console.cloud.google.com/apis/credentials');
        console.log('');

        const clientId = await promptForSecret('GOOGLE_CLIENT_ID', config);
        const r1 = await vault.setSecret('GOOGLE_CLIENT_ID', clientId);
        if (!r1.success) return false;

        const clientSecret = await promptForSecret('GOOGLE_CLIENT_SECRET', config);
        const r2 = await vault.setSecret('GOOGLE_CLIENT_SECRET', clientSecret);
        if (!r2.success) return false;

        console.log('   [OK] Stored Google OAuth credentials in vault');
        return true;
      } catch {
        return false;
      }
    },
    manualFix:
      'Store Google OAuth credentials:\n' +
      '      npx stack deploy --secrets set GOOGLE_CLIENT_ID\n' +
      '      npx stack deploy --secrets set GOOGLE_CLIENT_SECRET\n' +
      '      Get from: https://console.cloud.google.com/apis/credentials',
  },

  {
    id: 'auth-oauth-apple-missing',
    stage: 'secrets',
    severity: 'warning',
    description: 'Apple OAuth credentials not in vault (APPLE_CLIENT_ID)',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      if (!isOAuthEnabled(config, 'apple')) return false;

      try {
        const vault = await getVault(config, rootDir);
        const clientId = await vault.getSecret('APPLE_CLIENT_ID');
        return !clientId;
      } catch {
        return false;
      }
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      try {
        const { promptForSecret } = await import('../../../../utils/secret-prompts.js');
        const vault = await getVault(config, rootDir);

        console.log('');
        console.log('   Apple OAuth Setup');
        console.log('   Get credentials from: https://developer.apple.com/account/resources/identifiers');
        console.log('');

        const clientId = await promptForSecret('APPLE_CLIENT_ID', config);
        const r1 = await vault.setSecret('APPLE_CLIENT_ID', clientId);
        if (!r1.success) return false;

        console.log('   [OK] Stored Apple OAuth credentials in vault');
        return true;
      } catch {
        return false;
      }
    },
    manualFix:
      'Store Apple OAuth credentials:\n' +
      '      npx stack deploy --secrets set APPLE_CLIENT_ID\n' +
      '      Get from: https://developer.apple.com/account/resources/identifiers',
  },
];
