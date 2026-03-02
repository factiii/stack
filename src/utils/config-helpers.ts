/**
 * Config Helpers
 *
 * Helper functions for working with stack.yml config where
 * environments are stored as top-level keys.
 */

import * as fs from 'fs';
import yaml from 'js-yaml';
import type { FactiiiConfig, EnvironmentConfig } from '../types/index.js';
import { getStackConfigPath, getStackAutoPath, getStackLocalPath } from '../constants/config-files.js';

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
  'env_match_exceptions',  // Keys allowed to match across .env.example and staging/prod
] as const;

/**
 * Stage type definition
 */
export type Stage = 'dev' | 'secrets' | 'staging' | 'prod';

/**
 * Extract environment configs from config object
 * Environments = any top-level key NOT in reserved list
 *
 * @param config - The stack.yml config object
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
 * @param config - The stack.yml config object
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
 * @param config - The stack.yml config object
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
 * @param config - The stack.yml config object
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
/**
 * Local config interface (stack.local.yml)
 * Per-developer settings that are gitignored
 */
export interface LocalConfig {
  dev_os?: 'mac' | 'windows' | 'ubuntu';
  openclaw?: boolean | {
    model?: string;
  };
}

/**
 * Load local config from stack.local.yml (or factiii.local.yml)
 * Returns empty object if file doesn't exist
 *
 * @param rootDir - Root directory of the project
 * @returns Parsed local config or empty object
 */
export function loadLocalConfig(rootDir: string): LocalConfig {
  const localPath = getStackLocalPath(rootDir);
  if (!fs.existsSync(localPath)) {
    return {};
  }
  try {
    const content = fs.readFileSync(localPath, 'utf8');
    return (yaml.load(content) as LocalConfig) ?? {};
  } catch {
    return {};
  }
}

/**
 * Load merged config from stack.yml + stackAuto.yml
 * stack.yml values take priority over stackAuto.yml
 *
 * @param rootDir - Root directory of the project
 * @returns Merged config or empty object if no config exists
 */
export function loadConfig(rootDir: string): FactiiiConfig {
  const configPath = getStackConfigPath(rootDir);
  let config: FactiiiConfig = {} as FactiiiConfig;

  // Load stack.yml (user config)
  if (fs.existsSync(configPath)) {
    try {
      config = (yaml.load(fs.readFileSync(configPath, 'utf8')) as FactiiiConfig) ?? ({} as FactiiiConfig);
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      console.error('[!] Error parsing config: ' + errorMessage);
      return {} as FactiiiConfig;
    }
  }

  // Merge stackAuto.yml (auto-detected defaults, stack.yml wins)
  const autoPath = getStackAutoPath(rootDir);
  if (fs.existsSync(autoPath)) {
    try {
      const autoConfig = (yaml.load(fs.readFileSync(autoPath, 'utf8')) as Record<string, unknown>) ?? {};
      for (const [key, value] of Object.entries(autoConfig)) {
        if (!(key in config)) {
          // stackAuto.yml provides defaults that stack.yml can override
          (config as Record<string, unknown>)[key] = value;
        } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          // Deep merge objects (e.g., ansible section)
          const existing = (config as Record<string, unknown>)[key];
          if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
            (config as Record<string, unknown>)[key] = {
              ...(value as Record<string, unknown>),
              ...(existing as Record<string, unknown>),
            };
          }
        }
      }
    } catch {
      // stackAuto.yml parse error — ignore, stack.yml is sufficient
    }
  }

  return config;
}

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

