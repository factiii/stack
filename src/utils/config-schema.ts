/**
 * Config Schema Validator
 *
 * Validates factiii.yml against schema definitions for each version.
 * Detects missing required fields, deprecated fields, and new optional fields.
 */

import type {
  FactiiiConfig,
  ConfigVersionSchema,
  SchemaValidationResult,
} from '../types/index.js';

export const CURRENT_VERSION = '1.1.0';

// Schema definitions for each config version
export const SCHEMAS: Record<string, ConfigVersionSchema> = {
  '1.0.0': {
    required: ['name', 'aws', 'environments'],
    optional: [
      'github_repo',
      'ssl_email',
      'plugins',
      'servers',
      'ecr_registry',
      'ecr_repository',
      'prisma_schema',
      'prisma_version',
    ],
    awsFields: {
      required: ['access_key_id', 'region'],
      optional: [],
    },
    environmentFields: {
      required: ['server', 'domain', 'host'],
      optional: ['env_file'],
    },
  },
  '1.1.0': {
    required: ['name', 'aws', 'environments', 'config_version'],
    optional: [
      'github_repo',
      'ssl_email',
      'plugins',
      'servers',
      'ecr_registry',
      'ecr_repository',
      'prisma_schema',
      'prisma_version',
    ],
    awsFields: {
      required: ['access_key_id', 'region'],
      optional: [],
    },
    environmentFields: {
      required: ['server', 'domain', 'host'],
      optional: ['env_file', 'ssh_user'], // NEW in 1.1.0: per-environment SSH user
    },
  },
};

// Field descriptions for user-friendly messages
const FIELD_DESCRIPTIONS: Record<string, string> = {
  config_version: 'Config schema version for tracking updates',
  'environments.*.ssh_user':
    'SSH user for connecting to this environment (overrides global ssh_user from factiiiAuto.yml)',
};

/**
 * Compare two semver version strings
 * @param v1 - First version
 * @param v2 - Second version
 * @returns -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 */
export function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const p1 = parts1[i] ?? 0;
    const p2 = parts2[i] ?? 0;
    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }
  return 0;
}

/**
 * Check if version v1 is less than v2
 */
export function semverLt(v1: string, v2: string): boolean {
  return compareVersions(v1, v2) < 0;
}

interface NewOptionalField {
  path: string;
  description: string;
}

/**
 * Get all fields that exist in a newer schema but not in an older one
 * @param oldVersion - Old schema version
 * @param newVersion - New schema version
 * @returns Array of new optional fields with descriptions
 */
export function getNewOptionalFields(
  oldVersion: string,
  newVersion: string
): NewOptionalField[] {
  const oldSchema = SCHEMAS[oldVersion];
  const newSchema = SCHEMAS[newVersion];

  if (!oldSchema || !newSchema) return [];

  const newFields: NewOptionalField[] = [];

  // Check top-level optional fields
  const oldOptional = new Set(oldSchema.optional);
  newSchema.optional.forEach((field) => {
    if (!oldOptional.has(field)) {
      newFields.push({
        path: field,
        description: FIELD_DESCRIPTIONS[field] ?? 'New optional field',
      });
    }
  });

  // Check environment fields
  const oldEnvOptional = new Set(oldSchema.environmentFields.optional);
  newSchema.environmentFields.optional.forEach((field) => {
    if (!oldEnvOptional.has(field)) {
      newFields.push({
        path: `environments.*.${field}`,
        description:
          FIELD_DESCRIPTIONS[`environments.*.${field}`] ??
          'New optional environment field',
      });
    }
  });

  return newFields;
}

/**
 * Validate config against schema
 * @param config - Parsed factiii.yml config
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
    configVersion: config.config_version ?? '1.0.0',
    targetVersion,
  };

  // Get appropriate schema
  const schema = SCHEMAS[targetVersion];
  if (!schema) {
    result.valid = false;
    result.error = `Unknown schema version: ${targetVersion}`;
    return result;
  }

  // Check if config needs migration
  if (!config.config_version || semverLt(config.config_version, targetVersion)) {
    result.needsMigration = true;
    result.newOptional = getNewOptionalFields(result.configVersion, targetVersion);
  }

  // Validate required top-level fields
  schema.required.forEach((field) => {
    if (!(field in config)) {
      result.valid = false;
      result.missing.push(field);
    }
  });

  // Validate AWS fields
  if (config.aws) {
    schema.awsFields.required.forEach((field) => {
      if (!(field in config.aws!)) {
        result.valid = false;
        result.missing.push(`aws.${field}`);
      }
    });
  }

  // Validate environment fields
  if (config.environments) {
    Object.keys(config.environments).forEach((envName) => {
      const env = config.environments![envName];
      if (env) {
        schema.environmentFields.required.forEach((field) => {
          if (!(field in env)) {
            result.valid = false;
            result.missing.push(`environments.${envName}.${field}`);
          }
        });
      }
    });
  }

  return result;
}

/**
 * Get list of migrations needed to go from one version to another
 * @param fromVersion - Starting version
 * @param toVersion - Target version
 * @returns List of migration IDs needed
 */
export function getMigrationsNeeded(fromVersion: string, toVersion: string): string[] {
  const migrations: string[] = [];

  // Simple case: 1.0.0 -> 1.1.0
  if (semverLt(fromVersion, '1.1.0') && compareVersions(toVersion, '1.1.0') >= 0) {
    migrations.push('1.0.0_to_1.1.0');
  }

  return migrations;
}

