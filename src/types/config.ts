/**
 * Configuration Types
 *
 * Types for factiii.yml and factiiiAuto.yml configuration files.
 */

/**
 * AWS configuration section in factiii.yml
 */
export interface AWSConfig {
  access_key_id: string;
  region: string;
  config?: 'ec2' | 'free-tier' | 'standard' | 'enterprise';
}

/**
 * Environment configuration (staging, prod, etc.)
 */
export interface EnvironmentConfig {
  server?: string;
  domain: string;
  host: string;
  ssh_user?: string;
  env_file?: string;
}

/**
 * Main factiii.yml configuration
 */
export interface FactiiiConfig {
  name: string;
  config_version?: string;
  aws?: AWSConfig;
  environments?: Record<string, EnvironmentConfig>;
  github_repo?: string;
  ssl_email?: string;
  plugins?: string[];
  servers?: string[];
  ecr_registry?: string;
  ecr_repository?: string;
  prisma_schema?: string;
  prisma_version?: string;
  trusted_plugins?: string[];
  container_exclusions?: string[];
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

