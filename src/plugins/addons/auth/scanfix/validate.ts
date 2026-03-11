/**
 * Auth Validation Scanfixes (Staging/Prod)
 *
 * Validates that auth environment variables are properly
 * configured on staging and production servers.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { extractEnvironments, getDefaultVaultPath } from '../../../../utils/config-helpers.js';

/**
 * Check if an env file has a variable set (non-empty, non-EXAMPLE)
 */
function envFileHasVar(envFilePath: string, varName: string): boolean {
  if (!fs.existsSync(envFilePath)) return false;

  const content = fs.readFileSync(envFilePath, 'utf8');
  const regex = new RegExp('^' + varName + '\\s*=\\s*(.+)$', 'm');
  const match = content.match(regex);
  if (!match || !match[1]) return false;

  const value = match[1].trim();
  return value.length > 0 && !value.toUpperCase().startsWith('EXAMPLE');
}

export const validateFixes: Fix[] = [
  {
    id: 'auth-env-jwt-staging',
    stage: 'staging',
    severity: 'critical',
    description: 'JWT_SECRET not set in .env.staging (auth will not work)',
    scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const envPath = path.join(rootDir, '.env.staging');
      return !envFileHasVar(envPath, 'JWT_SECRET');
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      try {
        const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
        const vault = new AnsibleVaultSecrets({
          vault_path: config.ansible?.vault_path ?? getDefaultVaultPath(config),
          vault_password_file: config.ansible?.vault_password_file,
          rootDir,
        });

        const jwtSecret = await vault.getSecret('JWT_SECRET');
        if (!jwtSecret) {
          console.log('   JWT_SECRET not in vault — run: npx stack fix --secrets');
          return false;
        }

        // Append to .env.staging
        const envPath = path.join(rootDir, '.env.staging');
        let content = '';
        if (fs.existsSync(envPath)) {
          content = fs.readFileSync(envPath, 'utf8');
        }

        if (content.includes('JWT_SECRET=')) {
          // Replace existing (empty or EXAMPLE) value
          content = content.replace(/^JWT_SECRET\s*=.*$/m, 'JWT_SECRET=' + jwtSecret);
        } else {
          content = content.trimEnd() + '\nJWT_SECRET=' + jwtSecret + '\n';
        }

        fs.writeFileSync(envPath, content, 'utf8');
        console.log('   [OK] Set JWT_SECRET in .env.staging from vault');
        return true;
      } catch (e) {
        console.log('   Error: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Add JWT_SECRET to .env.staging or run: npx stack fix --secrets && npx stack fix --staging',
  },

  {
    id: 'auth-env-jwt-prod',
    stage: 'prod',
    severity: 'critical',
    description: 'JWT_SECRET not set in .env.prod (auth will not work)',
    scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const envPath = path.join(rootDir, '.env.prod');
      return !envFileHasVar(envPath, 'JWT_SECRET');
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      try {
        const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
        const vault = new AnsibleVaultSecrets({
          vault_path: config.ansible?.vault_path ?? getDefaultVaultPath(config),
          vault_password_file: config.ansible?.vault_password_file,
          rootDir,
        });

        const jwtSecret = await vault.getSecret('JWT_SECRET');
        if (!jwtSecret) {
          console.log('   JWT_SECRET not in vault — run: npx stack fix --secrets');
          return false;
        }

        // Append to .env.prod
        const envPath = path.join(rootDir, '.env.prod');
        let content = '';
        if (fs.existsSync(envPath)) {
          content = fs.readFileSync(envPath, 'utf8');
        }

        if (content.includes('JWT_SECRET=')) {
          content = content.replace(/^JWT_SECRET\s*=.*$/m, 'JWT_SECRET=' + jwtSecret);
        } else {
          content = content.trimEnd() + '\nJWT_SECRET=' + jwtSecret + '\n';
        }

        fs.writeFileSync(envPath, content, 'utf8');
        console.log('   [OK] Set JWT_SECRET in .env.prod from vault');
        return true;
      } catch (e) {
        console.log('   Error: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Add JWT_SECRET to .env.prod or run: npx stack fix --secrets && npx stack fix --prod',
  },
];
