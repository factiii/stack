/**
 * Server Plugin Interface
 *
 * Base class for all server plugins (mac-mini, aws, etc.)
 * Server plugins handle deployment to specific server types.
 */

import type {
  FactiiiConfig,
  EnvironmentConfig,
  Fix,
  DeployResult,
  EnsureServerReadyOptions,
} from '../../types/index.js';

/**
 * Abstract base class for server plugins
 */
export abstract class ServerPlugin {
  // ============================================================
  // REQUIRED STATIC PROPERTIES
  // ============================================================

  static readonly id: string = 'server-interface';
  static readonly name: string = 'Server Interface';
  static readonly category: 'server' = 'server';
  static readonly version: string = '1.0.0';

  static readonly fixes: Fix[] = [];
  static readonly requiredEnvVars: string[] = [];
  static readonly configSchema: Record<string, unknown> = {};
  static readonly autoConfigSchema: Record<string, string> = {};

  // ============================================================
  // INSTANCE PROPERTIES
  // ============================================================

  protected config: FactiiiConfig;

  constructor(config: FactiiiConfig) {
    this.config = config;
  }

  // ============================================================
  // REQUIRED STATIC METHODS
  // ============================================================

  /**
   * Determine if this plugin should be loaded for this project
   * @param rootDir - Project root directory
   * @param config - Loaded config
   */
  static async shouldLoad(_rootDir: string, _config: FactiiiConfig): Promise<boolean> {
    throw new Error('Server plugin must implement shouldLoad()');
  }

  /**
   * Auto-detect server configuration
   * @param rootDir - Project root directory
   */
  static async detectConfig(_rootDir: string): Promise<Record<string, unknown>> {
    return {};
  }

  /**
   * Execute a command on a remote server via SSH
   * @param envConfig - Environment config with host and ssh_user
   * @param command - Command to execute
   */
  static async sshExec(
    _envConfig: EnvironmentConfig,
    _command: string
  ): Promise<string> {
    throw new Error('Server plugin must implement sshExec()');
  }

  // ============================================================
  // REQUIRED INSTANCE METHODS
  // ============================================================

  /**
   * Ensure server is ready for deployment
   * Installs Node.js, git, clones repo, checks out commit
   */
  abstract ensureServerReady(
    config: FactiiiConfig,
    environment: string,
    options?: EnsureServerReadyOptions
  ): Promise<DeployResult>;

  /**
   * Deploy to an environment
   */
  abstract deploy(config: FactiiiConfig, environment: string): Promise<DeployResult>;

  /**
   * Undeploy from an environment
   */
  abstract undeploy(config: FactiiiConfig, environment: string): Promise<DeployResult>;
}

export default ServerPlugin;

