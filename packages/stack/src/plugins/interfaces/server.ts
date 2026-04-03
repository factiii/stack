/**
 * Server Plugin Interface
 *
 * Base class for all server plugins (mac, ubuntu, windows, etc.)
 * Server plugins represent OS types and handle OS-specific commands,
 * package management, and service management.
 *
 * Server plugins are NOT deployment targets - they define how to interact
 * with a specific operating system. Pipelines (like AWS, factiii) handle
 * the deployment orchestration and specify which OS types they support.
 */

import type {
  FactiiiConfig,
  EnvironmentConfig,
  Fix,
  DeployResult,
  EnsureServerReadyOptions,
  ServerOS,
  PackageManager,
  ServiceManager,
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

  /** The OS this server plugin handles */
  static readonly os: ServerOS;
  /** Package manager for this OS (brew, apt, choco, dnf, apk) */
  static readonly packageManager: PackageManager;
  /** Service manager for this OS (launchctl, systemd, windows-service) */
  static readonly serviceManager: ServiceManager;

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

