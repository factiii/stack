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
import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { parseEnvFile, compareEnvKeys, findMatchingValues } from '../../../../utils/env-validator.js';
import { extractEnvironments } from '../../../../utils/config-helpers.js';

/**
 * Values that are commonly identical across environments and shouldn't trigger warnings
 */
const TRIVIALLY_IDENTICAL = new Set(['', 'true', 'false', '0', '1', 'yes', 'no']);

export const envFileFixes: Fix[] = [
  // ── File existence checks ──────────────────────────────────────

  {
    id: 'missing-env-example',
    stage: 'dev',
    severity: 'warning',
    description: '.env.example not found (template for environment variables)',
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
    description: '.env.staging not found',
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
    description: '.env.prod not found',
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
    description: '.env.staging is missing keys from .env.example',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const envs = extractEnvironments(config);
      if (!envs.staging) return false;

      const dev = parseEnvFile(path.join(rootDir, '.env.example'));
      const staging = parseEnvFile(path.join(rootDir, '.env.staging'));
      if (!dev || !staging) return false;

      const comparison = compareEnvKeys(dev, staging);
      if (comparison.missing.length > 0) {
        // Store missing keys for display in description
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
    description: '.env.prod is missing keys from .env.example',
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

      const matching = findMatchingValues(dev, staging);
      // Filter out trivially-identical values
      const meaningful = matching.filter((key) => {
        const val = dev[key];
        return val !== undefined && !TRIVIALLY_IDENTICAL.has(val);
      });
      if (meaningful.length > 0) {
        (this as any)._matchingKeys = meaningful;
      }
      return meaningful.length > 0;
    },
    fix: null,
    manualFix: 'Change these values in .env.staging to differ from .env.example (they should have staging-specific values)',
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

      const matching = findMatchingValues(dev, prod);
      const meaningful = matching.filter((key) => {
        const val = dev[key];
        return val !== undefined && !TRIVIALLY_IDENTICAL.has(val);
      });
      if (meaningful.length > 0) {
        (this as any)._matchingKeys = meaningful;
      }
      return meaningful.length > 0;
    },
    fix: null,
    manualFix: 'Change these values in .env.prod to differ from .env.example (they should have production-specific values)',
  },

  // ── Vault storage ──────────────────────────────────────────────

  {
    id: 'env-staging-not-in-vault',
    stage: 'secrets',
    severity: 'warning',
    description: '.env.staging not stored in Ansible Vault',
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

      const envVars = parseEnvFile(path.join(rootDir, '.env.staging'));
      if (!envVars) return false;

      try {
        const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
        const vault = new AnsibleVaultSecrets({
          vault_path: config.ansible.vault_path,
          vault_password_file: config.ansible.vault_password_file ?? '~/.vault_pass',
          rootDir,
        });
        await vault.setEnvironmentSecrets('staging', envVars);
        console.log('   Stored .env.staging in vault as staging_envs');
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log('   Failed to store in vault: ' + msg);
        return false;
      }
    },
    manualFix: 'Run: npx stack fix (will store .env.staging in Ansible Vault)',
  },

  {
    id: 'env-prod-not-in-vault',
    stage: 'secrets',
    severity: 'warning',
    description: '.env.prod not stored in Ansible Vault',
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

      const envVars = parseEnvFile(path.join(rootDir, '.env.prod'));
      if (!envVars) return false;

      try {
        const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
        const vault = new AnsibleVaultSecrets({
          vault_path: config.ansible.vault_path,
          vault_password_file: config.ansible.vault_password_file ?? '~/.vault_pass',
          rootDir,
        });
        await vault.setEnvironmentSecrets('prod', envVars);
        console.log('   Stored .env.prod in vault as prod_envs');
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log('   Failed to store in vault: ' + msg);
        return false;
      }
    },
    manualFix: 'Run: npx stack fix (will store .env.prod in Ansible Vault)',
  },
];
