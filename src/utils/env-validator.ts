/**
 * Environment File Validator
 *
 * Utilities for parsing and validating .env files.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { FactiiiConfig } from '../types/index.js';

interface EnvVars {
  [key: string]: string;
}

interface KeyComparison {
  match: boolean;
  missing: string[];
  extra: string[];
}

interface EmptyCheck {
  allFilled: boolean;
  empty: string[];
}

interface PlaceholderInfo {
  key: string;
  value: string;
}

interface PlaceholderCheck {
  hasPlaceholders: boolean;
  placeholders: PlaceholderInfo[];
}

interface ProdDifferences {
  changed: string[];
  onlyLocal: string[];
  onlyGitHub: string[];
}

interface GitHubSecrets {
  PROD_ENVS?: EnvVars;
}

interface AutoConfig {
  isStagingSecret?: boolean;
  allowIdenticalEnvVars?: string[];
}

interface ConfigWithAuto extends FactiiiConfig {
  auto?: AutoConfig;
}

interface EnvValidationResult {
  devExists: boolean;
  stagingExists: boolean;
  prodExists: boolean;
  prodLocal: boolean;
  prodGitHub: boolean;
  prodGitignored: boolean;
  stagingGitignored: boolean;
  keysMatch: boolean;
  allFilled: boolean;
  warnings: string[];
  errors: string[];
  dev: EnvVars | null;
  staging: EnvVars | null;
  prod: EnvVars | null;
  prodGitHubData?: EnvVars;
  prodDifferences?: ProdDifferences;
}

/**
 * Parse .env file into key-value object
 * @param filepath - Path to .env file
 * @returns Parsed key-value pairs or null if file doesn't exist
 */
export function parseEnvFile(filepath: string): EnvVars | null {
  if (!fs.existsSync(filepath)) {
    return null;
  }

  const content = fs.readFileSync(filepath, 'utf8');
  const env: EnvVars = {};

  const lines = content.split('\n');
  for (const line of lines) {
    // Skip empty lines and comments
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Parse KEY=VALUE
    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (match) {
      const key = match[1]?.trim();
      const value = match[2]?.trim();
      if (key) {
        env[key] = value ?? '';
      }
    }
  }

  return env;
}

/**
 * Check if value looks like a placeholder
 * @param value - Environment variable value
 */
export function looksLikePlaceholder(value: string): boolean {
  if (!value || value === '') {
    return true;
  }

  return (
    value.includes('EXAMPLE') ||
    value.includes('<FILL') ||
    value.includes('your-') ||
    value.includes('TODO') ||
    value.includes('CHANGE_ME')
  );
}

/**
 * Check if file is in .gitignore
 * @param rootDir - Root directory
 * @param filename - Filename to check
 */
export function isGitignored(rootDir: string, filename: string): boolean {
  const gitignorePath = path.join(rootDir, '.gitignore');

  if (!fs.existsSync(gitignorePath)) {
    return false;
  }

  const gitignore = fs.readFileSync(gitignorePath, 'utf8');
  const lines = gitignore.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Check exact match or pattern match
    if (trimmed === filename) {
      return true;
    }

    // Check pattern match (e.g., .env.* matches .env.prod)
    if (trimmed.includes('*')) {
      const pattern = trimmed.replace(/\*/g, '.*');
      const regex = new RegExp(`^${pattern}$`);
      if (regex.test(filename)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Compare keys between two env objects
 * @param expected - Expected keys (from .env.example)
 * @param actual - Actual keys to validate
 */
export function compareEnvKeys(expected: EnvVars, actual: EnvVars): KeyComparison {
  const expectedKeys = Object.keys(expected);
  const actualKeys = Object.keys(actual);

  const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
  const extra = actualKeys.filter((key) => !expectedKeys.includes(key));

  return {
    match: missing.length === 0 && extra.length === 0,
    missing,
    extra,
  };
}

/**
 * Check if env values are filled (not empty)
 * @param env - Environment variables
 */
export function checkValuesNotEmpty(env: EnvVars): EmptyCheck {
  const empty: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    if (!value || value.trim() === '') {
      empty.push(key);
    }
  }

  return {
    allFilled: empty.length === 0,
    empty,
  };
}

/**
 * Check for placeholder values
 * @param env - Environment variables
 */
export function checkForPlaceholders(env: EnvVars): PlaceholderCheck {
  const placeholders: PlaceholderInfo[] = [];

  for (const [key, value] of Object.entries(env)) {
    if (looksLikePlaceholder(value)) {
      placeholders.push({ key, value });
    }
  }

  return {
    hasPlaceholders: placeholders.length > 0,
    placeholders,
  };
}

/**
 * Compare values between environments
 * @param env1 - First environment
 * @param env2 - Second environment
 * @returns Keys with matching values
 */
export function findMatchingValues(env1: EnvVars, env2: EnvVars): string[] {
  const matching: string[] = [];

  for (const key of Object.keys(env1)) {
    if (env2[key] && env1[key] === env2[key]) {
      matching.push(key);
    }
  }

  return matching;
}

/**
 * Validate environment file setup
 * @param rootDir - Root directory
 * @param config - Parsed factiii.yml config
 * @param githubSecrets - Optional GitHub secrets for comparison
 */
export function validateEnvFiles(
  rootDir: string,
  config: ConfigWithAuto = {} as ConfigWithAuto,
  githubSecrets: GitHubSecrets | null = null
): EnvValidationResult {
  const results: EnvValidationResult = {
    devExists: false,
    stagingExists: false,
    prodExists: false,
    prodLocal: false,
    prodGitHub: false,
    prodGitignored: false,
    stagingGitignored: false,
    keysMatch: true,
    allFilled: true,
    warnings: [],
    errors: [],
    dev: null,
    staging: null,
    prod: null,
  };

  // Parse .env files
  const devPath = path.join(rootDir, '.env.example');
  const stagingPath = path.join(rootDir, '.env.staging');
  const prodPath = path.join(rootDir, '.env.prod');

  results.dev = parseEnvFile(devPath);
  results.staging = parseEnvFile(stagingPath);
  results.prod = parseEnvFile(prodPath);

  results.devExists = results.dev !== null;
  results.stagingExists = results.staging !== null;
  results.prodLocal = results.prod !== null;

  // Check if prod exists in GitHub
  if (githubSecrets?.PROD_ENVS) {
    results.prodGitHub = true;
    results.prodGitHubData = githubSecrets.PROD_ENVS;
  }

  results.prodExists = results.prodLocal || results.prodGitHub;

  // Critical: .env.example must exist
  if (!results.devExists) {
    results.errors.push('.env.example not found (required as template)');
    return results;
  }

  // Critical: .env.staging must exist
  if (!results.stagingExists) {
    results.errors.push('.env.staging not found (required)');
  }

  // Warning: .env.prod missing (OK if in GitHub)
  if (!results.prodExists) {
    results.errors.push('.env.prod not found locally or in GitHub Secrets');
  } else if (!results.prodLocal && results.prodGitHub) {
    results.warnings.push('.env.prod not local, using GitHub Secrets (OK for security)');
  }

  // Validate .gitignore
  if (results.prodLocal) {
    results.prodGitignored = isGitignored(rootDir, '.env.prod');
    if (!results.prodGitignored) {
      results.errors.push('.env.prod MUST be in .gitignore');
    }
  }

  const isStagingSecret = config.auto?.isStagingSecret !== false; // default true
  results.stagingGitignored = isGitignored(rootDir, '.env.staging');
  if (isStagingSecret && !results.stagingGitignored) {
    results.warnings.push('.env.staging not gitignored (isStagingSecret: true)');
  }

  // Validate staging keys match dev
  if (results.stagingExists && results.dev && results.staging) {
    const keyCompare = compareEnvKeys(results.dev, results.staging);
    if (!keyCompare.match) {
      results.keysMatch = false;
      if (keyCompare.missing.length > 0) {
        results.errors.push(`.env.staging missing keys: ${keyCompare.missing.join(', ')}`);
      }
      if (keyCompare.extra.length > 0) {
        results.warnings.push(`.env.staging extra keys: ${keyCompare.extra.join(', ')}`);
      }
    }

    // Check values not empty
    const valueCheck = checkValuesNotEmpty(results.staging);
    if (!valueCheck.allFilled) {
      results.allFilled = false;
      results.errors.push(`.env.staging empty values: ${valueCheck.empty.join(', ')}`);
    }

    // Check for placeholders
    const placeholderCheck = checkForPlaceholders(results.staging);
    if (placeholderCheck.hasPlaceholders) {
      results.warnings.push(
        `.env.staging has placeholder values: ${placeholderCheck.placeholders.map((p) => p.key).join(', ')}`
      );
    }
  }

  // Validate prod keys (local or GitHub)
  const prodEnv = results.prodLocal ? results.prod : results.prodGitHubData;
  if (prodEnv && results.dev) {
    const keyCompare = compareEnvKeys(results.dev, prodEnv);
    if (!keyCompare.match) {
      results.keysMatch = false;
      const source = results.prodLocal ? 'local' : 'GitHub';
      if (keyCompare.missing.length > 0) {
        results.errors.push(`.env.prod (${source}) missing keys: ${keyCompare.missing.join(', ')}`);
      }
      if (keyCompare.extra.length > 0) {
        results.warnings.push(`.env.prod (${source}) extra keys: ${keyCompare.extra.join(', ')}`);
      }
    }

    // Check values not empty
    const valueCheck = checkValuesNotEmpty(prodEnv);
    if (!valueCheck.allFilled) {
      results.allFilled = false;
      const source = results.prodLocal ? 'local' : 'GitHub';
      results.errors.push(`.env.prod (${source}) empty values: ${valueCheck.empty.join(', ')}`);
    }

    // Check for placeholders
    const placeholderCheck = checkForPlaceholders(prodEnv);
    if (placeholderCheck.hasPlaceholders) {
      const source = results.prodLocal ? 'local' : 'GitHub';
      results.warnings.push(
        `.env.prod (${source}) has placeholder values: ${placeholderCheck.placeholders.map((p) => p.key).join(', ')}`
      );
    }
  }

  // Compare staging vs prod values (should be different)
  if (results.staging && prodEnv) {
    const matching = findMatchingValues(results.staging, prodEnv);
    const allowedIdentical = config.auto?.allowIdenticalEnvVars ?? [];
    const actualWarnings = matching.filter((key) => !allowedIdentical.includes(key));

    if (actualWarnings.length > 0) {
      results.warnings.push(
        `Staging/prod values identical (should differ): ${actualWarnings.join(', ')}`
      );
    }
  }

  // Compare local prod vs GitHub prod
  if (results.prodLocal && results.prodGitHub && results.prod && results.prodGitHubData) {
    const localKeys = Object.keys(results.prod);
    const githubKeys = Object.keys(results.prodGitHubData);
    const differences: string[] = [];

    for (const key of localKeys) {
      if (results.prod[key] !== results.prodGitHubData[key]) {
        differences.push(key);
      }
    }

    // Check for keys only in one or the other
    const onlyLocal = localKeys.filter((k) => !githubKeys.includes(k));
    const onlyGitHub = githubKeys.filter((k) => !localKeys.includes(k));

    if (differences.length > 0 || onlyLocal.length > 0 || onlyGitHub.length > 0) {
      results.warnings.push('Local .env.prod differs from GitHub PROD_ENVS');
      results.prodDifferences = {
        changed: differences,
        onlyLocal,
        onlyGitHub,
      };
    }
  }

  return results;
}

