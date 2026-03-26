/**
 * AWS Configuration Type Definitions
 *
 * Standardized interface for all AWS config types (ec2, free-tier, standard, enterprise).
 * All configs must implement this interface for consistency.
 */

import type { FactiiiConfig, Fix, DeployResult } from '../../../../types/index.js';

/**
 * Standard AWS Configuration Definition
 *
 * Each AWS config type (ec2, free-tier, etc.) must implement this interface.
 * Configs are selected based on `config.aws.config` value in stack.yml.
 */
export interface AWSConfigDef {
  /** Unique identifier for this config type */
  name: string;

  /** Human-readable description of what this config provides */
  description: string;

  /** List of AWS services used by this config */
  services: string[];

  /** Default values for this config (instance_type, storage, etc.) */
  defaults: Record<string, unknown>;

  /** Config-specific fixes (merged with base plugin fixes) */
  fixes: Fix[];

  /**
   * Deploy using this config
   * Called during deployment to execute config-specific deployment logic
   */
  deploy: (config: FactiiiConfig, environment: string) => Promise<DeployResult>;

  /**
   * Scan for issues specific to this config
   * Returns array of Fix objects for issues found
   */
  scan: (config: FactiiiConfig, environment: string) => Promise<Fix[]>;
}

