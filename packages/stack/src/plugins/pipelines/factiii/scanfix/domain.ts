/**
 * Domain/CORS Validation Scanfixes
 *
 * Validates that URL-based environment variables in .env.staging/.env.prod
 * match the domains configured in stack.yml. Catches:
 * - NEXTAUTH_URL pointing to wrong domain
 * - API_URL / CORS_ORIGIN mismatches
 * - Stale domains after config changes
 * - Missing CORS keys in .env.example
 * - nginx.conf / docker-compose.yml domain mismatches (server-side)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { extractEnvironments, hasEnvironments } from '../../../../utils/config-helpers.js';
import { parseEnvFile } from '../../../../utils/env-validator.js';

/**
 * Common env var names that contain URLs/domains and should match the configured domain.
 * These are checked in .env.staging and .env.prod against stack.yml domains.
 */
const DOMAIN_ENV_KEYS = [
  'NEXTAUTH_URL',
  'NEXT_PUBLIC_API_URL',
  'NEXT_PUBLIC_APP_URL',
  'API_URL',
  'APP_URL',
  'CORS_ORIGIN',
  'CORS_ALLOWED_ORIGINS',
  'BASE_URL',
  'SITE_URL',
];

/**
 * Extract hostname from a URL string.
 * Handles comma-separated lists (e.g., CORS_ALLOWED_ORIGINS=https://a.com,https://b.com)
 * Returns all unique hostnames found.
 */
function extractDomains(value: string): string[] {
  const domains: string[] = [];
  // Split on commas for multi-origin values
  const parts = value.split(',').map(s => s.trim());
  for (const part of parts) {
    try {
      const parsed = new URL(part);
      if (parsed.hostname) domains.push(parsed.hostname);
    } catch {
      // Not a valid URL, skip
    }
  }
  return domains;
}

/**
 * Find env vars whose domain doesn't match the expected domain from stack.yml.
 * Returns array of { key, actual, expected } for mismatched vars.
 */
function findDomainMismatches(
  envVars: Record<string, string>,
  expectedDomain: string
): Array<{ key: string; actual: string; expected: string }> {
  const mismatches: Array<{ key: string; actual: string; expected: string }> = [];

  for (const key of DOMAIN_ENV_KEYS) {
    const value = envVars[key];
    if (!value) continue;

    // Skip EXAMPLE_ placeholders
    if (value.toUpperCase().startsWith('EXAMPLE')) continue;

    const domains = extractDomains(value);
    if (domains.length === 0) continue;

    // Check if ANY of the domains match the expected domain
    const hasMatch = domains.some(d => d === expectedDomain);
    if (!hasMatch) {
      mismatches.push({
        key,
        actual: domains.join(', '),
        expected: expectedDomain,
      });
    }
  }

  return mismatches;
}

export const domainFixes: Fix[] = [
  {
    id: 'env-cors-domain-mismatch-staging',
    stage: 'dev',
    targetStage: 'staging',
    severity: 'warning',
    get description(): string {
      const mismatches = (this as any)._mismatches as Array<{ key: string; actual: string; expected: string }> | undefined;
      if (mismatches && mismatches.length > 0) {
        const shown = mismatches.map(m => m.key + ' → ' + m.actual).join(', ');
        return '.env.staging has URLs pointing to wrong domain: ' + shown + ' (expected: ' + mismatches[0]!.expected + ')';
      }
      return '.env.staging has URLs that do not match staging domain in stack.yml';
    },
    scan: async function (config: FactiiiConfig, rootDir: string): Promise<boolean> {
      if (!hasEnvironments(config)) return false;

      const envs = extractEnvironments(config);
      if (!envs.staging) return false;

      const domain = envs.staging.domain;
      if (!domain || domain.toUpperCase().startsWith('EXAMPLE')) return false;

      const envPath = path.join(rootDir, '.env.staging');
      const envVars = parseEnvFile(envPath);
      if (!envVars) return false;

      const mismatches = findDomainMismatches(envVars, domain);
      if (mismatches.length > 0) {
        (this as any)._mismatches = mismatches;
      }
      return mismatches.length > 0;
    },
    fix: null,
    manualFix:
      'Update URL env vars in .env.staging to use the correct domain from stack.yml.\n' +
      '      Common vars to check: NEXTAUTH_URL, NEXT_PUBLIC_API_URL, API_URL, CORS_ORIGIN, BASE_URL',
  },

  {
    id: 'env-cors-domain-mismatch-prod',
    stage: 'dev',
    targetStage: 'prod',
    severity: 'warning',
    get description(): string {
      const mismatches = (this as any)._mismatches as Array<{ key: string; actual: string; expected: string }> | undefined;
      if (mismatches && mismatches.length > 0) {
        const shown = mismatches.map(m => m.key + ' → ' + m.actual).join(', ');
        return '.env.prod has URLs pointing to wrong domain: ' + shown + ' (expected: ' + mismatches[0]!.expected + ')';
      }
      return '.env.prod has URLs that do not match prod domain in stack.yml';
    },
    scan: async function (config: FactiiiConfig, rootDir: string): Promise<boolean> {
      if (!hasEnvironments(config)) return false;

      const envs = extractEnvironments(config);
      const prodEnv = envs.prod ?? envs.production;
      if (!prodEnv) return false;

      const domain = prodEnv.domain;
      if (!domain || domain.toUpperCase().startsWith('EXAMPLE')) return false;

      const envPath = path.join(rootDir, '.env.prod');
      const envVars = parseEnvFile(envPath);
      if (!envVars) return false;

      const mismatches = findDomainMismatches(envVars, domain);
      if (mismatches.length > 0) {
        (this as any)._mismatches = mismatches;
      }
      return mismatches.length > 0;
    },
    fix: null,
    manualFix:
      'Update URL env vars in .env.prod to use the correct domain from stack.yml.\n' +
      '      Common vars to check: NEXTAUTH_URL, NEXT_PUBLIC_API_URL, API_URL, CORS_ORIGIN, BASE_URL',
  },

  // ============================================================
  // .env.example — ensure CORS/URL keys are defined
  // ============================================================
  {
    id: 'env-example-missing-cors-keys',
    stage: 'dev',
    severity: 'warning',
    get description(): string {
      const missing = (this as any)._missingKeys as string[] | undefined;
      if (missing && missing.length > 0) {
        return '.env.example is missing CORS/URL keys: ' + missing.join(', ');
      }
      return '.env.example is missing common CORS/URL environment variable keys';
    },
    scan: async function (config: FactiiiConfig, rootDir: string): Promise<boolean> {
      if (!hasEnvironments(config)) return false;

      const envPath = path.join(rootDir, '.env.example');
      const envVars = parseEnvFile(envPath);
      if (!envVars) return false;

      // Check which CORS/URL keys are missing from .env.example
      // Only flag keys that are actually used in .env.staging or .env.prod
      const envs = extractEnvironments(config);
      const usedKeys = new Set<string>();

      for (const envName of Object.keys(envs)) {
        const envFileName = '.env.' + (envName === 'production' ? 'prod' : envName);
        const envFileVars = parseEnvFile(path.join(rootDir, envFileName));
        if (!envFileVars) continue;
        for (const key of DOMAIN_ENV_KEYS) {
          if (envFileVars[key]) usedKeys.add(key);
        }
      }

      // Find keys used in staging/prod but missing from .env.example
      const missing = Array.from(usedKeys).filter(key => !envVars[key] && envVars[key] !== '');
      if (missing.length > 0) {
        (this as any)._missingKeys = missing;
      }
      return missing.length > 0;
    },
    fix: null,
    manualFix:
      'Add the missing CORS/URL keys to .env.example so developers know to configure them.\n' +
      '      Example: NEXTAUTH_URL=https://EXAMPLE_yourdomain.com\n' +
      '      This ensures .env.staging and .env.prod stay in sync with the template.',
  },

  // ============================================================
  // Server-side: nginx.conf domain validation
  // ============================================================
  {
    id: 'nginx-domain-mismatch',
    stage: 'staging',
    severity: 'warning',
    get description(): string {
      const details = (this as any)._details as { missing: string[]; stale: string[] } | undefined;
      if (details) {
        const parts: string[] = [];
        if (details.missing.length > 0) parts.push('missing: ' + details.missing.join(', '));
        if (details.stale.length > 0) parts.push('stale: ' + details.stale.join(', '));
        return 'nginx.conf domains do not match stack.yml (' + parts.join('; ') + ')';
      }
      return 'nginx.conf domains do not match stack.yml configuration';
    },
    scan: async function (config: FactiiiConfig): Promise<boolean> {
      if (!hasEnvironments(config)) return false;

      const factiiiDir = process.env.FACTIII_DIR ?? path.join(os.homedir(), '.factiii');
      const nginxPath = path.join(factiiiDir, 'nginx.conf');
      if (!fs.existsSync(nginxPath)) return false;

      const nginxContent = fs.readFileSync(nginxPath, 'utf8');

      // Extract server_name directives from nginx.conf
      const serverNameRegex = /server_name\s+([^;]+);/g;
      const nginxDomains = new Set<string>();
      let match;
      while ((match = serverNameRegex.exec(nginxContent)) !== null) {
        const names = match[1]!.trim().split(/\s+/);
        for (const name of names) {
          if (name && name !== '_') nginxDomains.add(name);
        }
      }

      // Get expected domains from stack.yml
      const envs = extractEnvironments(config);
      const expectedDomains = new Set<string>();
      for (const envConfig of Object.values(envs)) {
        const domain = (envConfig as any).domain as string | undefined;
        if (domain && !domain.toUpperCase().startsWith('EXAMPLE')) {
          expectedDomains.add(domain);
        }
      }

      if (expectedDomains.size === 0) return false;

      // Find mismatches
      const missing = Array.from(expectedDomains).filter(d => !nginxDomains.has(d));
      const stale = Array.from(nginxDomains).filter(d => !expectedDomains.has(d));

      if (missing.length > 0 || stale.length > 0) {
        (this as any)._details = { missing, stale };
        return true;
      }
      return false;
    },
    fix: null,
    manualFix:
      'Redeploy to regenerate nginx.conf: npx stack deploy --staging\n' +
      '      This will regenerate nginx.conf with the correct domains from stack.yml.',
  },

  // ============================================================
  // Server-side: docker-compose.yml domain/service validation
  // ============================================================
  {
    id: 'compose-domain-mismatch',
    stage: 'staging',
    severity: 'warning',
    get description(): string {
      const details = (this as any)._details as { missing: string[]; stale: string[] } | undefined;
      if (details) {
        const parts: string[] = [];
        if (details.missing.length > 0) parts.push('missing: ' + details.missing.join(', '));
        if (details.stale.length > 0) parts.push('stale: ' + details.stale.join(', '));
        return 'docker-compose.yml services do not match stack.yml (' + parts.join('; ') + ')';
      }
      return 'docker-compose.yml services do not match stack.yml configuration';
    },
    scan: async function (config: FactiiiConfig): Promise<boolean> {
      if (!hasEnvironments(config)) return false;

      const factiiiDir = process.env.FACTIII_DIR ?? path.join(os.homedir(), '.factiii');
      const composePath = path.join(factiiiDir, 'docker-compose.yml');
      if (!fs.existsSync(composePath)) return false;

      let composeContent: any;
      try {
        const yaml = await import('js-yaml');
        composeContent = yaml.load(fs.readFileSync(composePath, 'utf8'));
      } catch {
        return false;
      }

      const composeServices = new Set<string>(
        Object.keys(composeContent?.services ?? {}).filter(s => s !== 'nginx')
      );

      // Get expected services from stack.yml: {repoName}-{envName}
      const repoName = config.name as string | undefined;
      if (!repoName) return false;

      const envs = extractEnvironments(config);
      const expectedServices = new Set<string>();
      for (const envName of Object.keys(envs)) {
        expectedServices.add(repoName + '-' + envName);
      }

      if (expectedServices.size === 0) return false;

      // Find mismatches
      const missing = Array.from(expectedServices).filter(s => !composeServices.has(s));
      const stale = Array.from(composeServices).filter(s => s.startsWith(repoName + '-') && !expectedServices.has(s));

      if (missing.length > 0 || stale.length > 0) {
        (this as any)._details = { missing, stale };
        return true;
      }
      return false;
    },
    fix: null,
    manualFix:
      'Redeploy to regenerate docker-compose.yml: npx stack deploy --staging\n' +
      '      This will regenerate docker-compose.yml with the correct services from stack.yml.',
  },
];
