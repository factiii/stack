/**
 * Config Helpers
 *
 * Helper functions for working with factiii.yml config where
 * environments are stored as top-level keys.
 */

import type { FactiiiConfig, EnvironmentConfig } from '../types/index.js';

// ============================================================
// CRITICAL: Config Environment Extraction
// ============================================================
// Why this exists: Environments are stored as top-level keys
// What breaks if changed: All environment iteration, plugin loading
// Dependencies: All CLI commands, plugins, generators
// ============================================================

/**
 * Reserved top-level config keys that are NOT environments
 * Everything else at the top level is treated as an environment
 */
export const RESERVED_CONFIG_KEYS = [
  'name',
  'config_version',
  'github_repo',
  'ssl_email',
  'pipeline',
  'prisma_schema',
  'prisma_version',
  'container_exclusions',
  'trusted_plugins',
  'ansible',  // Ansible Vault configuration (not an environment)
] as const;

/**
 * Stage type definition
 */
export type Stage = 'dev' | 'secrets' | 'staging' | 'prod';

/**
 * Extract environment configs from config object
 * Environments = any top-level key NOT in reserved list
 *
 * @param config - The factiii.yml config object
 * @returns Record of environment name to environment config
 */
export function extractEnvironments(
  config: FactiiiConfig
): Record<string, EnvironmentConfig> {
  const environments: Record<string, EnvironmentConfig> = {};

  for (const [key, value] of Object.entries(config)) {
    // Skip reserved keys
    if (RESERVED_CONFIG_KEYS.includes(key as (typeof RESERVED_CONFIG_KEYS)[number])) {
      continue;
    }

    // Only include objects (not strings, arrays, or nulls)
    if (typeof value === 'object' && !Array.isArray(value) && value !== null) {
      environments[key] = value as EnvironmentConfig;
    }
  }

  return environments;
}

/**
 * Map environment name to stage
 *
 * Rules:
 * - 'dev' → 'dev'
 * - 'secrets' → 'secrets'
 * - starts with 'staging' or 'stage-' → 'staging'
 * - starts with 'prod' or equals 'production' → 'prod'
 *
 * @param envName - Environment name (e.g., 'staging2', 'prod')
 * @returns Stage name ('dev' | 'secrets' | 'staging' | 'prod')
 * @throws Error if environment name doesn't match any pattern
 */
export function getStageFromEnvironment(envName: string): Stage {
  if (envName === 'dev') return 'dev';
  if (envName === 'secrets') return 'secrets';
  if (envName.startsWith('staging') || envName.startsWith('stage-')) return 'staging';
  if (envName.startsWith('prod') || envName === 'production') return 'prod';

  throw new Error(
    `Cannot determine stage for environment: ${envName}. ` +
      `Environment names must start with 'staging', 'prod', or be 'dev'/'secrets'.`
  );
}

/**
 * Get all environments that match a specific stage
 *
 * @param config - The factiii.yml config object
 * @param stage - Stage to filter by ('staging' | 'prod')
 * @returns Record of environment name to environment config for matching stage
 */
export function getEnvironmentsForStage(
  config: FactiiiConfig,
  stage: Stage
): Record<string, EnvironmentConfig> {
  const allEnvs = extractEnvironments(config);
  const filtered: Record<string, EnvironmentConfig> = {};

  for (const [name, env] of Object.entries(allEnvs)) {
    try {
      if (getStageFromEnvironment(name) === stage) {
        filtered[name] = env;
      }
    } catch {
      // Skip environments that don't match any stage pattern
      continue;
    }
  }

  return filtered;
}

/**
 * Get used server plugins from config
 * Looks at all environments and returns unique server plugin names
 *
 * @param config - The factiii.yml config object
 * @returns Set of server plugin names used across all environments
 */
export function getUsedServerPlugins(config: FactiiiConfig): Set<string> {
  const servers = new Set<string>();
  const environments = extractEnvironments(config);

  for (const env of Object.values(environments)) {
    if (env.server) {
      servers.add(env.server);
    }
  }

  return servers;
}

/**
 * Get used plugins from config
 * Looks at all environment plugin configs and returns unique plugin names
 *
 * @param config - The factiii.yml config object
 * @returns Set of plugin names used across all environments
 */
export function getUsedPlugins(config: FactiiiConfig): Set<string> {
  const plugins = new Set<string>();
  const environments = extractEnvironments(config);

  for (const env of Object.values(environments)) {
    if (env.plugins) {
      for (const pluginName of Object.keys(env.plugins)) {
        plugins.add(pluginName);
      }
    }
  }

  return plugins;
}

/**
 * Validate environment name
 * Checks that environment name doesn't conflict with reserved keys
 * and follows naming conventions
 *
 * @param name - Environment name to validate
 * @returns Error message if invalid, null if valid
 */
export function validateEnvironmentName(name: string): string | null {
  // Check for reserved key conflicts
  if (RESERVED_CONFIG_KEYS.includes(name as (typeof RESERVED_CONFIG_KEYS)[number])) {
    return `Invalid environment name '${name}' - this is a reserved config field. Please use a different name (e.g., '${name}-env', 'staging', 'prod').`;
  }

  // Check for valid characters
  if (!/^[a-z0-9-]+$/.test(name)) {
    return `Invalid environment name '${name}' - must contain only lowercase letters, numbers, and hyphens.`;
  }

  // Must match a stage pattern
  try {
    getStageFromEnvironment(name);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return message;
  }

  return null;
}

