/**
 * CLI Types
 *
 * Types for CLI command options and results.
 */

import type { Stage, Fix } from './plugin.js';

/**
 * Base options shared by most commands
 */
export interface BaseOptions {
  rootDir?: string;
}

/**
 * Options for the scan command
 */
export interface ScanOptions extends BaseOptions {
  dev?: boolean;
  staging?: boolean;
  prod?: boolean;
  secrets?: boolean;
  stages?: Stage[];
  commit?: string;
  silent?: boolean;
  onServer?: boolean;
}

/**
 * Problems found during scan, grouped by stage
 */
export interface ScanProblems {
  dev: Fix[];
  secrets: Fix[];
  staging: Fix[];
  prod: Fix[];
}

/**
 * Options for the deploy command
 */
export interface DeployOptions extends ScanOptions {
  environment?: string;
  branch?: string;
  token?: string;
}

/**
 * Options for the fix command
 */
export interface FixOptions extends ScanOptions {
  token?: string;
  continueOnError?: boolean;
}

/**
 * Result of running fixes
 */
export interface FixResult {
  fixed: number;
  manual: number;
  failed: number;
  fixes: {
    id: string;
    stage: Stage;
    status: 'fixed' | 'manual' | 'failed';
    error?: string;
  }[];
}

/**
 * Options for the init command
 */
export interface InitOptions extends BaseOptions {
  force?: boolean;
}

/**
 * Options for the undeploy command
 */
export interface UndeployOptions extends BaseOptions {
  dev?: boolean;
  staging?: boolean;
  prod?: boolean;
  environment?: string;
}

/**
 * Options for the secrets command
 */
export interface SecretsOptions {
  value?: string;
  deploy?: boolean;
  token?: string;
}

/**
 * Options for the upgrade command
 */
export interface UpgradeOptions extends BaseOptions {
  check?: boolean;
}

/**
 * Options for the validate command (legacy)
 */
export interface ValidateOptions {
  config?: string;
}

/**
 * Options for the check-config command (legacy)
 */
export interface CheckConfigOptions {
  environment?: string;
}

/**
 * Options for generate-workflows command
 */
export interface GenerateWorkflowsOptions {
  output?: string;
}

/**
 * Reachability info for display
 */
export interface ReachabilityInfo {
  reachable: boolean;
  reason?: string;
  via?: string;
}

/**
 * Reachability map by stage
 */
export type ReachabilityMap = Record<Stage, ReachabilityInfo>;

