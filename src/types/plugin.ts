/**
 * Plugin Types
 *
 * Types for the Factiii plugin system.
 */

import type { FactiiiConfig } from './config.js';

/**
 * Deployment stages
 */
export type Stage = 'dev' | 'secrets' | 'staging' | 'prod';

/**
 * Fix severity levels
 */
export type Severity = 'critical' | 'warning' | 'info';

/**
 * How a stage can be reached
 */
export type ReachVia = 'local' | 'workflow' | 'api' | 'github-api';

/**
 * Reachability check result - discriminated union for type safety
 */
export type Reachability =
  | { reachable: true; via: ReachVia }
  | { reachable: false; reason: string };

/**
 * A fix definition that can detect and resolve issues
 */
export interface Fix {
  id: string;
  stage: Stage;
  severity: Severity;
  description: string;
  plugin?: string;
  scan: (config: FactiiiConfig, rootDir: string) => Promise<boolean>;
  fix?: ((config: FactiiiConfig, rootDir: string) => Promise<boolean>) | null;
  manualFix: string;
}

/**
 * Plugin categories
 */
export type PluginCategory = 'pipeline' | 'server' | 'framework' | 'addon';

/**
 * Plugin metadata for listing
 */
export interface PluginMetadata {
  id: string;
  category: string;
  name: string;
  version: string;
}

/**
 * Result of a deploy/undeploy operation
 */
export interface DeployResult {
  success: boolean;
  message?: string;
  error?: string;
}

/**
 * Options for ensuring server is ready
 */
export interface EnsureServerReadyOptions {
  commitHash?: string;
  branch?: string;
  repoUrl?: string;
}

/**
 * SSH command result
 */
export interface SSHResult {
  success: boolean;
  output?: string;
  error?: string;
}

/**
 * Server software check results
 */
export interface ServerSoftwareChecks {
  git: boolean;
  docker: boolean;
  dockerCompose: boolean;
  node: boolean;
}

/**
 * Server environment detection result
 */
export interface ServerEnvironment {
  os: 'macos' | 'linux' | 'unknown';
  packageManager: 'brew' | 'apt' | 'yum' | null;
  hasHomebrew: boolean;
  hasApt: boolean;
  hasYum: boolean;
}

/**
 * Server dependency installation results
 */
export interface DependencyInstallResult {
  needed: boolean;
  installed: boolean;
  error: string | null;
}

/**
 * Server dependencies installation results
 */
export interface InstallDependenciesResult {
  success: boolean;
  error?: string;
  serverEnv?: ServerEnvironment;
  results: {
    node: DependencyInstallResult;
    git: DependencyInstallResult;
    docker: DependencyInstallResult;
    pnpm: DependencyInstallResult;
  };
}

/**
 * Server connectivity check result
 */
export interface ConnectivityResult {
  ssh: boolean;
  error?: string;
}

/**
 * Repository check result
 */
export interface RepoCheckResult {
  exists: boolean;
  branch?: string;
}

/**
 * Config validation result on server
 */
export interface ConfigValidationResult {
  expectedServices: number;
  actualServices: number;
  nginxMatches: boolean | null;
  dockerComposeUpToDate: boolean | null;
}

/**
 * Comprehensive server scan result
 */
export interface ServerScanResult {
  environment: string;
  ssh: boolean;
  git: boolean;
  docker: boolean;
  dockerCompose: boolean;
  node: boolean;
  repo: boolean;
  branch: string | null;
  repoName: string;
  configValidation: ConfigValidationResult | null;
  error?: string;
}

/**
 * Server basics setup result
 */
export interface ServerBasicsResult {
  gitInstalled: boolean;
  dockerInstalled: boolean;
  repoCloned: boolean;
  repoExists: boolean;
  configMismatch: boolean;
}

/**
 * Base interface for all plugin classes (static side)
 */
export interface PluginStatic {
  readonly id: string;
  readonly name: string;
  readonly category: PluginCategory;
  readonly version: string;
  readonly fixes: Fix[];
  readonly requiredEnvVars: string[];
  readonly configSchema: Record<string, unknown>;
  readonly autoConfigSchema: Record<string, string>;

  shouldLoad(rootDir: string, config: FactiiiConfig): Promise<boolean>;
  detectConfig?(rootDir: string): Promise<Record<string, unknown>>;
}

/**
 * Base interface for plugin instances
 */
export interface PluginInstance {
  config: FactiiiConfig;
  deploy(config: FactiiiConfig, environment: string): Promise<DeployResult>;
  undeploy(config: FactiiiConfig, environment: string): Promise<DeployResult>;
}

/**
 * Pipeline plugin static interface
 */
export interface PipelinePluginStatic extends PluginStatic {
  readonly category: 'pipeline';
  canReach(stage: Stage, config: FactiiiConfig): Reachability;
  requiresFullRepo?(environment: string): boolean;
  generateWorkflows?(rootDir: string): Promise<void>;
  triggerWorkflow?(workflowName: string, inputs?: Record<string, string>): Promise<void>;
}

/**
 * Server plugin static interface
 */
export interface ServerPluginStatic extends PluginStatic {
  readonly category: 'server';
  sshExec?(envConfig: { host: string; ssh_user?: string }, command: string): Promise<string>;
}

/**
 * Server plugin instance interface
 */
export interface ServerPluginInstance extends PluginInstance {
  ensureServerReady(
    config: FactiiiConfig,
    environment: string,
    options?: EnsureServerReadyOptions
  ): Promise<DeployResult>;
}

/**
 * Framework plugin static interface
 */
export interface FrameworkPluginStatic extends PluginStatic {
  readonly category: 'framework';
}

/**
 * Addon plugin static interface
 */
export interface AddonPluginStatic extends PluginStatic {
  readonly category: 'addon';
}

/**
 * Union type for any plugin class
 */
export type AnyPluginStatic =
  | PipelinePluginStatic
  | ServerPluginStatic
  | FrameworkPluginStatic
  | AddonPluginStatic;

/**
 * Constructor type for plugin classes
 */
export interface PluginConstructor<T extends PluginInstance = PluginInstance> {
  new (config: FactiiiConfig): T;
  readonly id: string;
  readonly name: string;
  readonly category: PluginCategory;
  readonly version: string;
  readonly fixes: Fix[];
  readonly requiredEnvVars: string[];
  shouldLoad(rootDir: string, config: FactiiiConfig): Promise<boolean>;
}

