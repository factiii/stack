/**
 * Configuration Types
 *
 * Types for factiii.yml and factiiiAuto.yml configuration files.
 */

/**
 * Environment configuration (staging, prod, etc.)
 *
 * Environments are top-level keys with all their config inline.
 * Each environment specifies which server plugin to use and can have
 * server-specific or plugin-specific configuration.
 */
export interface EnvironmentConfig {
  // Required fields
  server: string;  // Server plugin name (aws, mac-mini, etc.)
  domain: string;  // Domain for nginx/SSL AND SSH connection

  // Optional base fields
  ssh_user?: string;
  env_file?: string;

  // AWS-specific fields (when server: aws)
  config?: 'ec2' | 'free-tier' | 'standard' | 'enterprise';
  access_key_id?: string;
  region?: string;

  // Plugin-specific configuration for this environment
  // Example: plugins: { ecr: { ecr_registry: '...', ecr_repository: '...' } }
  plugins?: Record<string, Record<string, unknown>>;
}

/**
 * Main factiii.yml configuration
 *
 * Environments are stored as top-level keys. Any key that is NOT
 * in the reserved list (name, config_version, github_repo, etc.)
 * is treated as an environment configuration.
 *
 * Note: This interface uses an index signature to support dynamic environment keys.
 */
export interface FactiiiConfig {
  // Required fields
  name: string;

  // Reserved config fields
  config_version?: string;
  github_repo?: string;
  ssl_email?: string;
  pipeline?: string;  // Pipeline plugin name (e.g., 'factiii')
  prisma_schema?: string | null;
  prisma_version?: string | null;
  trusted_plugins?: string[];
  container_exclusions?: string[];

  // Dynamic environment keys
  // Any top-level key NOT in the reserved list above is an environment
  // Example: staging, staging2, prod, prod2, qa, etc.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [environmentName: string]: any;
}

/**
 * Auto-detected configuration (factiiiAuto.yml)
 */
export interface FactiiiAutoConfig {
  ssh_user?: string;
  dockerfile?: string;
  package_manager?: 'npm' | 'yarn' | 'pnpm';
  node_version?: string;
  pnpm_version?: string;
  prisma_schema?: string;
  prisma_version?: string;
  aws_cli_installed?: boolean;
}

/**
 * Schema field definition for config validation
 */
export interface SchemaFields {
  required: string[];
  optional: string[];
}

/**
 * AWS fields schema
 */
export interface AWSFieldsSchema {
  required: string[];
  optional: string[];
}

/**
 * Environment fields schema
 */
export interface EnvironmentFieldsSchema {
  required: string[];
  optional: string[];
}

/**
 * Complete schema definition for a config version
 */
export interface ConfigVersionSchema {
  required: string[];
  optional: string[];
  awsFields: AWSFieldsSchema;
  environmentFields: EnvironmentFieldsSchema;
}

/**
 * Schema validation result
 */
export interface SchemaValidationResult {
  valid: boolean;
  missing: string[];
  deprecated: string[];
  newOptional: Array<{ path: string; description: string }>;
  needsMigration: boolean;
  configVersion: string;
  targetVersion: string;
  error?: string;
}

