/**
 * Configuration Types
 *
 * Types for stack.yml and factiiiAuto.yml configuration files.
 */

/**
 * Server OS types (duplicated here to avoid circular imports)
 */
export type ServerOSConfig = 'mac' | 'ubuntu' | 'windows' | 'amazon-linux' | 'alpine';

/**
 * Environment configuration (staging, prod, etc.)
 *
 * Environments are top-level keys with all their config inline.
 * Each environment specifies which server OS to use and can have
 * pipeline-specific or plugin-specific configuration.
 */
export interface EnvironmentConfig {
  // Required fields
  server: ServerOSConfig;  // Server OS type (mac, ubuntu, windows, etc.)
  domain: string;          // Domain for nginx/SSL AND SSH connection

  // Optional base fields
  ssh_user?: string;
  ssl_email?: string;   // Email for Let's Encrypt SSL certificates
  env_file?: string;

  // Server mode addon - enables server hardening fixes (default: true for staging/prod)
  server_mode?: boolean;

  // Pipeline-specific fields (when using aws pipeline)
  pipeline?: string;  // Pipeline plugin name (factiii, aws, etc.)
  config?: 'ec2' | 'free-tier' | 'standard' | 'enterprise';  // AWS tier
  access_key_id?: string;
  region?: string;

  // Plugin-specific configuration for this environment
  // Example: plugins: { ecr: { ecr_registry: '...', ecr_repository: '...' } }
  plugins?: Record<string, Record<string, unknown>>;
}

/**
 * Top-level `aws:` block in stack.yml.
 *
 * Holds region/credentials and per-resource name overrides so a project can
 * adopt pre-existing AWS resources whose names don't follow the convention
 * (`factiii-{project}-X`) without having to rename them in AWS.
 */
export interface AwsBlockConfig {
  region?: string;
  config?: 'ec2' | 'free-tier' | 'standard' | 'enterprise';
  access_key_id?: string;

  /** Override S3 bucket name. Default: `factiii-{project}` or `factiii-{project}-{accountId}`. */
  s3_bucket?: string;
  /** Override RDS DBInstanceIdentifier. Default: `factiii-{project}-db`. */
  rds_instance_id?: string;
  /** Override ECR repository name. Default: `{project}`. */
  ecr_repository?: string;
  /** Override EC2 security group name. Default: `factiii-{project}-ec2`. */
  ec2_security_group?: string;
  /** Override RDS security group name. Default: `factiii-{project}-rds`. */
  rds_security_group?: string;

  // ──────────────────────────────────────────────────────────
  // Network overrides — adopt an existing VPC instead of letting stack
  // create its own (`factiii-{project}` VPC at 10.0.0.0/16). If `vpc_id`
  // is set, the VPC/subnet/IGW create scanfixes self-skip and downstream
  // resources (RDS, EC2, SGs) are looked up inside the override VPC.
  // ──────────────────────────────────────────────────────────
  /** Existing VPC to use for prod resources. Skips VPC + IGW creation. */
  vpc_id?: string;
  /**
   * Subnet to launch the EC2 instance into. If unset and `vpc_id` is set,
   * stack picks any subnet in that VPC where MapPublicIpOnLaunch=true
   * (matches the AWS default-VPC behaviour).
   */
  subnet_public_id?: string;
  /**
   * Two or more subnets across different AZs for the RDS subnet group.
   * If unset and `vpc_id` is set, stack picks one subnet per AZ in the
   * override VPC, up to three.
   */
  subnet_private_ids?: string[];
}

/**
 * Main stack.yml configuration
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

  // AWS configuration (region/creds/name overrides)
  aws?: AwsBlockConfig;

  // Top-level ECR overrides (legacy spots, also readable from aws.ecr_repository)
  ecr_registry?: string;
  ecr_repository?: string;

  // Ansible Vault configuration (for secrets)
  ansible?: {
    vault_path: string;
    vault_password_file?: string;
  };

  // Dev-only mode: when true (default), staging/prod stages and Ansible are disabled.
  // Set dev_only: false in stack.local to unlock.
  dev_only?: boolean;

  // Keys allowed to have identical values across .env.example and staging/prod
  env_match_exceptions?: string[];

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

  // AWS resource IDs (populated after provisioning)
  aws_vpc_id?: string;
  aws_subnet_public_id?: string;
  aws_subnet_private_ids?: string[];
  aws_sg_ec2_id?: string;
  aws_sg_rds_id?: string;
  aws_ec2_instance_id?: string;
  aws_ec2_public_ip?: string;
  aws_rds_endpoint?: string;
  aws_rds_db_name?: string;
  aws_s3_bucket?: string;
  aws_ecr_registry?: string;
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

