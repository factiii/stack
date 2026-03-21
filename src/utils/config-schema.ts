/**
 * Config Schema Validator
 *
 * Validates stack.yml against schema definitions for each version.
 * Detects missing required fields, deprecated fields, and new optional fields.
 */

import type {
  FactiiiConfig,
  ConfigVersionSchema,
  SchemaValidationResult,
} from '../types/index.js';
import { extractEnvironments } from './config-helpers.js';

export const CURRENT_VERSION = '0.1.0';

// Schema definition for config version 0.1.0
export const SCHEMAS: Record<string, ConfigVersionSchema> = {
  '0.1.0': {
    // Environments are top-level keys, not nested
    required: ['name', 'config_version'],
    optional: [
      'github_repo',
      'ssl_email',
      'pipeline',  // Single pipeline name
      'prisma_schema',
      'prisma_version',
      'container_exclusions',
      'trusted_plugins',
    ],
    awsFields: {
      // AWS fields are per-environment, not global
      required: [],
      optional: [],
    },
    environmentFields: {
      // Environment fields
      required: ['server', 'domain'],
      optional: [
        'env_file',
        'ssh_user',
        'config',  // AWS config type
        'access_key_id',  // AWS credentials
        'region',  // AWS region
        'plugins',  // Plugin configs
      ],
    },
  },
};

// Field descriptions for user-friendly messages
const FIELD_DESCRIPTIONS: Record<string, string> = {
  config_version: 'Config schema version',
  pipeline: 'Pipeline plugin to use for deployments (e.g., factiii for GitHub Actions)',
  'environment.*.plugins': 'Plugin-specific configuration for this environment',
  'environment.*.ssh_user': 'SSH user for connecting to this environment',
};


/**
 * Validate config against schema
 * @param config - Parsed stack.yml config
 * @param targetVersion - Target schema version (defaults to current)
 * @returns Validation result
 */
export function validateConfigSchema(
  config: FactiiiConfig,
  targetVersion: string = CURRENT_VERSION
): SchemaValidationResult {
  const result: SchemaValidationResult = {
    valid: true,
    missing: [],
    deprecated: [],
    newOptional: [],
    needsMigration: false,
    configVersion: config.config_version ?? CURRENT_VERSION,
    targetVersion,
  };

  // Get appropriate schema
  const schema = SCHEMAS[targetVersion];
  if (!schema) {
    result.valid = false,
    result.error = `Unknown schema version: ${targetVersion}`;
    return result;
  }

  // Validate required top-level fields
  schema.required.forEach((field) => {
    if (!(field in config)) {
      result.valid = false;
      result.missing.push(field);
    }
  });

  // Validate environment fields
  // Environments are top-level keys
  const environments = extractEnvironments(config);

  // Validate each environment
  Object.keys(environments).forEach((envName) => {
    const env = environments[envName];
    if (env && typeof env === 'object') {
      schema.environmentFields.required.forEach((field) => {
        if (!(field in env)) {
          result.valid = false;
          result.missing.push(`${envName}.${field}`);
        }
      });
    }
  });

  return result;
}

