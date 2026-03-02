/**
 * Environment file scanfixes for Factiii Pipeline plugin
 *
 * Validates .env.example, .env.staging, .env.prod:
 * - File existence
 * - Key completeness (all keys from .env.example present)
 * - Value matching warnings (staging/prod values shouldn't match dev)
 * - Vault storage (env files should be encrypted in Ansible Vault)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { parseEnvFile, compareEnvKeys, findMatchingValues } from '../../../../utils/env-validator.js';
import { extractEnvironments } from '../../../../utils/config-helpers.js';

/**
 * Values that are commonly identical across environments and shouldn't trigger warnings
 */
const TRIVIALLY_IDENTICAL = new Set(['', 'true', 'false', '0', '1', 'yes', 'no']);

/**
 * Get exception list from stack.yml config
 * Users can set env_match_exceptions: [KEY1, KEY2] to suppress "matches dev" warnings
 */
function getExceptionList(config: FactiiiConfig): Set<string> {
  const exceptions = (config as any).env_match_exceptions;
  if (Array.isArray(exceptions)) {
    return new Set(exceptions.map(String));
  }
  return new Set();
}

/**
 * Prompt user for a single env var value (used during interactive fix)
 */
function promptForValue(key: string, exampleValue: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const hint = exampleValue ? ' (example: ' + exampleValue + ')' : '';
    rl.question('   ' + key + hint + ': ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export const envFileFixes: Fix[] = [
  // ── File existence checks ──────────────────────────────────────

  {
    id: 'missing-env-example',
    stage: 'dev',
    severity: 'warning',
    description: '📄 .env.example not found (template for environment variables)',
    scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      return !fs.existsSync(path.join(rootDir, '.env.example'));
    },
    fix: null,
    manualFix: 'Create .env.example with your environment variables as a template',
  },

  {
    id: 'missing-env-staging',
    stage: 'staging',
    severity: 'critical',
    description: '📄 .env.staging not found',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const envs = extractEnvironments(config);
      if (!envs.staging) return false; // staging not configured, skip
      return !fs.existsSync(path.join(rootDir, '.env.staging'));
    },
    fix: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const examplePath = path.join(rootDir, '.env.example');
      if (!fs.existsSync(examplePath)) return false;
      fs.copyFileSync(examplePath, path.join(rootDir, '.env.staging'));
      console.log('   Copied .env.example to .env.staging - edit with real staging values');
      return true;
    },
    manualFix: 'Copy .env.example to .env.staging and fill in staging values',
  },

  {
    id: 'missing-env-prod',
    stage: 'prod',
    severity: 'critical',
    description: '📄 .env.prod not found',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const envs = extractEnvironments(config);
      const hasProd = !!envs.prod || !!envs.production;
      if (!hasProd) return false; // prod not configured, skip
      return !fs.existsSync(path.join(rootDir, '.env.prod'));
    },
    fix: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const examplePath = path.join(rootDir, '.env.example');
      if (!fs.existsSync(examplePath)) return false;
      fs.copyFileSync(examplePath, path.join(rootDir, '.env.prod'));
      console.log('   Copied .env.example to .env.prod - edit with real production values');
      return true;
    },
    manualFix: 'Copy .env.example to .env.prod and fill in production values',
  },

  // ── Key validation ─────────────────────────────────────────────

  {
    id: 'env-staging-missing-keys',
    stage: 'dev',
    severity: 'critical',
    description: '🔑 .env.staging is missing keys from .env.example',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const envs = extractEnvironments(config);
      if (!envs.staging) return false;

      const dev = parseEnvFile(path.join(rootDir, '.env.example'));
      const staging = parseEnvFile(path.join(rootDir, '.env.staging'));
      if (!dev || !staging) return false;

      const comparison = compareEnvKeys(dev, staging);
      if (comparison.missing.length > 0) {
        (this as any)._missingKeys = comparison.missing;
      }
      return comparison.missing.length > 0;
    },
    fix: null,
    manualFix: 'Add missing keys to .env.staging (compare with .env.example)',
  },

  {
    id: 'env-prod-missing-keys',
    stage: 'dev',
    severity: 'critical',
    description: '🔑 .env.prod is missing keys from .env.example',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const envs = extractEnvironments(config);
      const hasProd = !!envs.prod || !!envs.production;
      if (!hasProd) return false;

      const dev = parseEnvFile(path.join(rootDir, '.env.example'));
      const prod = parseEnvFile(path.join(rootDir, '.env.prod'));
      if (!dev || !prod) return false;

      const comparison = compareEnvKeys(dev, prod);
      return comparison.missing.length > 0;
    },
    fix: null,
    manualFix: 'Add missing keys to .env.prod (compare with .env.example)',
  },

  // ── Value matching warnings (dev vs staging/prod) ──────────────

  {
    id: 'env-staging-matches-dev',
    stage: 'dev',
    severity: 'warning',
    get description(): string {
      const keys = (this as any)._matchingKeys as string[] | undefined;
      if (keys && keys.length > 0) {
        const shown = keys.slice(0, 5).join(', ');
        const more = keys.length > 5 ? ' (+' + (keys.length - 5) + ' more)' : '';
        return '.env.staging has ' + keys.length + ' values identical to .env.example: ' + shown + more;
      }
      return '.env.staging has values identical to .env.example (probably needs updating)';
    },
    scan: async function (config: FactiiiConfig, rootDir: string): Promise<boolean> {
      const envs = extractEnvironments(config);
      if (!envs.staging) return false;

      const dev = parseEnvFile(path.join(rootDir, '.env.example'));
      const staging = parseEnvFile(path.join(rootDir, '.env.staging'));
      if (!dev || !staging) return false;

      const exceptions = getExceptionList(config);
      const matching = findMatchingValues(dev, staging);
      // Filter out trivially-identical values and user-configured exceptions
      const meaningful = matching.filter((key) => {
        if (exceptions.has(key)) return false;
        const val = dev[key];
        return val !== undefined && !TRIVIALLY_IDENTICAL.has(val);
      });
      if (meaningful.length > 0) {
        (this as any)._matchingKeys = meaningful;
      }
      return meaningful.length > 0;
    },
    fix: null,
    manualFix: 'Change these values in .env.staging to differ from .env.example (they should have staging-specific values). If a key is intentionally identical, add it to env_match_exceptions in stack.yml',
  },

  {
    id: 'env-prod-matches-dev',
    stage: 'dev',
    severity: 'warning',
    get description(): string {
      const keys = (this as any)._matchingKeys as string[] | undefined;
      if (keys && keys.length > 0) {
        const shown = keys.slice(0, 5).join(', ');
        const more = keys.length > 5 ? ' (+' + (keys.length - 5) + ' more)' : '';
        return '.env.prod has ' + keys.length + ' values identical to .env.example: ' + shown + more;
      }
      return '.env.prod has values identical to .env.example (probably needs updating)';
    },
    scan: async function (config: FactiiiConfig, rootDir: string): Promise<boolean> {
      const envs = extractEnvironments(config);
      const hasProd = !!envs.prod || !!envs.production;
      if (!hasProd) return false;

      const dev = parseEnvFile(path.join(rootDir, '.env.example'));
      const prod = parseEnvFile(path.join(rootDir, '.env.prod'));
      if (!dev || !prod) return false;

      const exceptions = getExceptionList(config);
      const matching = findMatchingValues(dev, prod);
      const meaningful = matching.filter((key) => {
        if (exceptions.has(key)) return false;
        const val = dev[key];
        return val !== undefined && !TRIVIALLY_IDENTICAL.has(val);
      });
      if (meaningful.length > 0) {
        (this as any)._matchingKeys = meaningful;
      }
      return meaningful.length > 0;
    },
    fix: null,
    manualFix: 'Change these values in .env.prod to differ from .env.example (they should have production-specific values). If a key is intentionally identical, add it to env_match_exceptions in stack.yml',
  },

  // ── Vault storage (dev stage — checks vault from dev machine) ──

  {
    id: 'env-staging-not-in-vault',
    stage: 'dev',
    severity: 'warning',
    description: '🔐 .env.staging not stored in Ansible Vault',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      if (!config.ansible?.vault_path) return false;

      const envs = extractEnvironments(config);
      if (!envs.staging) return false;
      if (!fs.existsSync(path.join(rootDir, '.env.staging'))) return false;

      try {
        const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
        const vault = new AnsibleVaultSecrets({
          vault_path: config.ansible.vault_path,
          vault_password_file: config.ansible.vault_password_file ?? '~/.vault_pass',
          rootDir,
        });
        const has = await vault.hasEnvironmentSecrets('staging');
        return !has;
      } catch {
        return false; // Can't check vault, skip
      }
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      if (!config.ansible?.vault_path) return false;

      const envPath = path.join(rootDir, '.env.staging');
      const envVars = parseEnvFile(envPath);
      if (!envVars || Object.keys(envVars).length === 0) {
        console.log('   No variables found in .env.staging');
        return false;
      }

      console.log('   Found ' + Object.keys(envVars).length + ' vars in .env.staging');
      console.log('   Importing into Ansible Vault as staging_envs...');

      try {
        const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
        const vault = new AnsibleVaultSecrets({
          vault_path: config.ansible.vault_path,
          vault_password_file: config.ansible.vault_password_file ?? '~/.vault_pass',
          rootDir,
        });
        await vault.setEnvironmentSecrets('staging', envVars);
        console.log('   Stored ' + Object.keys(envVars).length + ' staging env vars in vault');
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log('   Failed to store in vault: ' + msg);
        return false;
      }
    },
    manualFix: 'Run: npx stack fix --dev (will import .env.staging into Ansible Vault)',
  },

  {
    id: 'env-prod-not-in-vault',
    stage: 'dev',
    severity: 'warning',
    description: '🔐 .env.prod not stored in Ansible Vault',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      if (!config.ansible?.vault_path) return false;

      const envs = extractEnvironments(config);
      const hasProd = !!envs.prod || !!envs.production;
      if (!hasProd) return false;
      if (!fs.existsSync(path.join(rootDir, '.env.prod'))) return false;

      try {
        const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
        const vault = new AnsibleVaultSecrets({
          vault_path: config.ansible.vault_path,
          vault_password_file: config.ansible.vault_password_file ?? '~/.vault_pass',
          rootDir,
        });
        const has = await vault.hasEnvironmentSecrets('prod');
        return !has;
      } catch {
        return false;
      }
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      if (!config.ansible?.vault_path) return false;

      const envPath = path.join(rootDir, '.env.prod');
      const envVars = parseEnvFile(envPath);
      if (!envVars || Object.keys(envVars).length === 0) {
        console.log('   No variables found in .env.prod');
        return false;
      }

      console.log('   Found ' + Object.keys(envVars).length + ' vars in .env.prod');
      console.log('   Importing into Ansible Vault as prod_envs...');

      try {
        const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
        const vault = new AnsibleVaultSecrets({
          vault_path: config.ansible.vault_path,
          vault_password_file: config.ansible.vault_password_file ?? '~/.vault_pass',
          rootDir,
        });
        await vault.setEnvironmentSecrets('prod', envVars);
        console.log('   Stored ' + Object.keys(envVars).length + ' prod env vars in vault');
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log('   Failed to store in vault: ' + msg);
        return false;
      }
    },
    manualFix: 'Run: npx stack fix --dev (will import .env.prod into Ansible Vault)',
  },

  // ── Vault completeness (vault secrets missing keys from .env.example) ──

  {
    id: 'env-staging-vault-missing-keys',
    stage: 'dev',
    severity: 'critical',
    get description(): string {
      const keys = (this as any)._missingKeys as string[] | undefined;
      if (keys && keys.length > 0) {
        const shown = keys.slice(0, 5).join(', ');
        const more = keys.length > 5 ? ' (+' + (keys.length - 5) + ' more)' : '';
        return '🔐 Vault staging_envs missing ' + keys.length + ' keys from .env.example: ' + shown + more;
      }
      return '🔐 Vault staging_envs missing keys from .env.example';
    },
    scan: async function (config: FactiiiConfig, rootDir: string): Promise<boolean> {
      if (!config.ansible?.vault_path) return false;

      const envs = extractEnvironments(config);
      if (!envs.staging) return false;

      const dev = parseEnvFile(path.join(rootDir, '.env.example'));
      if (!dev) return false;

      try {
        const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
        const vault = new AnsibleVaultSecrets({
          vault_path: config.ansible.vault_path,
          vault_password_file: config.ansible.vault_password_file ?? '~/.vault_pass',
          rootDir,
        });
        const vaultSecrets = await vault.getEnvironmentSecrets('staging');
        if (Object.keys(vaultSecrets).length === 0) return false; // No vault secrets yet, handled by env-staging-not-in-vault

        const comparison = compareEnvKeys(dev, vaultSecrets);
        if (comparison.missing.length > 0) {
          (this as any)._missingKeys = comparison.missing;
        }
        return comparison.missing.length > 0;
      } catch {
        return false;
      }
    },
    fix: async function (config: FactiiiConfig, rootDir: string): Promise<boolean> {
      if (!config.ansible?.vault_path) return false;

      const dev = parseEnvFile(path.join(rootDir, '.env.example'));
      if (!dev) return false;

      try {
        const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
        const vault = new AnsibleVaultSecrets({
          vault_path: config.ansible.vault_path,
          vault_password_file: config.ansible.vault_password_file ?? '~/.vault_pass',
          rootDir,
        });
        const vaultSecrets = await vault.getEnvironmentSecrets('staging');
        const comparison = compareEnvKeys(dev, vaultSecrets);

        if (comparison.missing.length === 0) return true;

        console.log('   Missing ' + comparison.missing.length + ' keys in vault staging_envs');
        console.log('   Enter values for each missing key (from .env.example):');

        const newSecrets: Record<string, string> = {};
        for (const key of comparison.missing) {
          const exampleVal = dev[key] ?? '';
          const value = await promptForValue(key, exampleVal);
          newSecrets[key] = value || exampleVal; // Use example value if left blank
        }

        await vault.setEnvironmentSecrets('staging', newSecrets);
        console.log('   Added ' + comparison.missing.length + ' keys to vault staging_envs');
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log('   Failed: ' + msg);
        return false;
      }
    },
    manualFix: 'Run: npx stack fix --dev (will prompt for missing staging secret values)',
  },

  {
    id: 'env-prod-vault-missing-keys',
    stage: 'dev',
    severity: 'critical',
    get description(): string {
      const keys = (this as any)._missingKeys as string[] | undefined;
      if (keys && keys.length > 0) {
        const shown = keys.slice(0, 5).join(', ');
        const more = keys.length > 5 ? ' (+' + (keys.length - 5) + ' more)' : '';
        return '🔐 Vault prod_envs missing ' + keys.length + ' keys from .env.example: ' + shown + more;
      }
      return '🔐 Vault prod_envs missing keys from .env.example';
    },
    scan: async function (config: FactiiiConfig, rootDir: string): Promise<boolean> {
      if (!config.ansible?.vault_path) return false;

      const envs = extractEnvironments(config);
      const hasProd = !!envs.prod || !!envs.production;
      if (!hasProd) return false;

      const dev = parseEnvFile(path.join(rootDir, '.env.example'));
      if (!dev) return false;

      try {
        const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
        const vault = new AnsibleVaultSecrets({
          vault_path: config.ansible.vault_path,
          vault_password_file: config.ansible.vault_password_file ?? '~/.vault_pass',
          rootDir,
        });
        const vaultSecrets = await vault.getEnvironmentSecrets('prod');
        if (Object.keys(vaultSecrets).length === 0) return false; // No vault secrets yet

        const comparison = compareEnvKeys(dev, vaultSecrets);
        if (comparison.missing.length > 0) {
          (this as any)._missingKeys = comparison.missing;
        }
        return comparison.missing.length > 0;
      } catch {
        return false;
      }
    },
    fix: async function (config: FactiiiConfig, rootDir: string): Promise<boolean> {
      if (!config.ansible?.vault_path) return false;

      const dev = parseEnvFile(path.join(rootDir, '.env.example'));
      if (!dev) return false;

      try {
        const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
        const vault = new AnsibleVaultSecrets({
          vault_path: config.ansible.vault_path,
          vault_password_file: config.ansible.vault_password_file ?? '~/.vault_pass',
          rootDir,
        });
        const vaultSecrets = await vault.getEnvironmentSecrets('prod');
        const comparison = compareEnvKeys(dev, vaultSecrets);

        if (comparison.missing.length === 0) return true;

        console.log('   Missing ' + comparison.missing.length + ' keys in vault prod_envs');
        console.log('   Enter values for each missing key (from .env.example):');

        const newSecrets: Record<string, string> = {};
        for (const key of comparison.missing) {
          const exampleVal = dev[key] ?? '';
          const value = await promptForValue(key, exampleVal);
          newSecrets[key] = value || exampleVal;
        }

        await vault.setEnvironmentSecrets('prod', newSecrets);
        console.log('   Added ' + comparison.missing.length + ' keys to vault prod_envs');
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log('   Failed: ' + msg);
        return false;
      }
    },
    manualFix: 'Run: npx stack fix --dev (will prompt for missing prod secret values)',
  },
];
