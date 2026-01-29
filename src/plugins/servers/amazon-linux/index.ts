/**
 * Amazon Linux Server Plugin
 *
 * Handles Amazon Linux-specific package management and commands.
 * Used for deploying to AWS EC2 instances running Amazon Linux 2023.
 *
 * ============================================================
 * PLUGIN STRUCTURE STANDARD
 * ============================================================
 *
 * This plugin follows a standardized structure for clarity and maintainability:
 *
 * **scanfix/** - Scan/fix operations organized by concern
 *   - Each file exports an array of Fix[] objects
 *   - All fixes are combined in the main plugin class
 *
 * **index.ts** - Main plugin class
 *   - Static metadata (id, name, category, version, os, packageManager, serviceManager)
 *   - shouldLoad() - Determines if plugin should load
 *   - OS-specific installation commands
 * ============================================================
 */

import { execSync } from 'child_process';
import type {
  FactiiiConfig,
  EnvironmentConfig,
  DeployResult,
  EnsureServerReadyOptions,
  ServerOS,
  PackageManager,
  ServiceManager,
} from '../../../types/index.js';

// Import shared scanfix factories
import {
  getDockerFixes,
  getNodeFixes,
  getGitFixes,
  getPnpmFixes,
  createCertbotFix,
} from '../../../scanfix/index.js';

// Import SSH helper
import { sshExec } from '../../../utils/ssh-helper.js';

class AmazonLinuxPlugin {
  // ============================================================
  // STATIC METADATA
  // ============================================================

  static readonly id = 'amazon-linux';
  static readonly name = 'Amazon Linux Server';
  static readonly category: 'server' = 'server';
  static readonly version = '1.0.0';

  /** The OS this server plugin handles */
  static readonly os: ServerOS = 'amazon-linux';
  /** Package manager for Amazon Linux (dnf for AL2023, yum for AL2) */
  static readonly packageManager: PackageManager = 'dnf';
  /** Service manager for Amazon Linux */
  static readonly serviceManager: ServiceManager = 'systemd';

  // Env vars this plugin requires
  static readonly requiredEnvVars: string[] = [];

  // Schema for factiii.yml (user-editable)
  static readonly configSchema: Record<string, unknown> = {};

  // Schema for factiiiAuto.yml (auto-detected)
  static readonly autoConfigSchema: Record<string, string> = {
    ssh_user: 'string',
  };

  /**
   * Determine if this plugin should be loaded for this project
   * Loads if config has environment with server: 'amazon-linux'
   */
  static async shouldLoad(_rootDir: string, config: FactiiiConfig): Promise<boolean> {
    // Dynamic import to avoid circular dependencies
    const { extractEnvironments } = await import('../../../utils/config-helpers.js');

    const environments = extractEnvironments(config);

    for (const env of Object.values(environments)) {
      // Load if environment explicitly uses 'amazon-linux' server
      if (env.server === 'amazon-linux') {
        return true;
      }
    }

    return false;
  }

  static helpText: Record<string, string> = {
    SSH: `
   SSH private key for accessing the Amazon Linux server.

   For AWS EC2:
   - Use the key pair you created when launching the instance
   - Download the .pem file from AWS Console

   Default user for Amazon Linux: ec2-user`,
  };

  // ============================================================
  // FIXES - All issues this plugin can detect and resolve
  // ============================================================
  // All fixes are OS-specific to Amazon Linux
  // ============================================================

  static readonly fixes = [
    // Dev stage - shared fixes (with OS filter)
    ...getDockerFixes('dev').map(fix => ({ ...fix, os: 'amazon-linux' as ServerOS })),

    // Staging stage - shared fixes (with OS filter)
    ...getDockerFixes('staging').map(fix => ({ ...fix, os: 'amazon-linux' as ServerOS })),
    ...getNodeFixes('staging').map(fix => ({ ...fix, os: 'amazon-linux' as ServerOS })),
    ...getGitFixes('staging').map(fix => ({ ...fix, os: 'amazon-linux' as ServerOS })),
    ...getPnpmFixes('staging').map(fix => ({ ...fix, os: 'amazon-linux' as ServerOS })),
    { ...createCertbotFix('staging', 'staging'), os: 'amazon-linux' as ServerOS },

    // Prod stage - shared fixes (with OS filter)
    ...getDockerFixes('prod').map(fix => ({ ...fix, os: 'amazon-linux' as ServerOS })),
    ...getNodeFixes('prod').map(fix => ({ ...fix, os: 'amazon-linux' as ServerOS })),
    ...getGitFixes('prod').map(fix => ({ ...fix, os: 'amazon-linux' as ServerOS })),
    { ...createCertbotFix('prod', 'prod'), os: 'amazon-linux' as ServerOS },
  ];

  // ============================================================
  // STATIC HELPER METHODS
  // ============================================================

  /**
   * Auto-detect Amazon Linux configuration
   */
  static async detectConfig(_rootDir: string): Promise<{ ssh_user: string }> {
    return {
      ssh_user: 'ec2-user', // Default SSH user for Amazon Linux
    };
  }

  /**
   * Execute a command on a remote server via SSH
   */
  static async sshExec(envConfig: EnvironmentConfig, command: string): Promise<string> {
    return await sshExec(envConfig, command);
  }

  // ============================================================
  // AMAZON LINUX-SPECIFIC INSTALLATION COMMANDS
  // ============================================================

  /**
   * Get the command to install Docker on Amazon Linux 2023
   */
  static getDockerInstallCommand(): string {
    return `
      sudo dnf update -y && \
      sudo dnf install -y docker && \
      sudo systemctl start docker && \
      sudo systemctl enable docker && \
      sudo usermod -aG docker $USER
    `;
  }

  /**
   * Get the command to install Node.js on Amazon Linux
   */
  static getNodeInstallCommand(): string {
    return `
      curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - && \
      sudo dnf install -y nodejs
    `;
  }

  /**
   * Get the command to install git on Amazon Linux
   */
  static getGitInstallCommand(): string {
    return 'sudo dnf install -y git';
  }

  // ============================================================
  // INSTANCE METHODS
  // ============================================================

  private _config: FactiiiConfig;

  constructor(config: FactiiiConfig) {
    this._config = config;
  }

  /**
   * Ensure server is ready for deployment
   */
  async ensureServerReady(
    config: FactiiiConfig,
    environment: string,
    options: EnsureServerReadyOptions = {}
  ): Promise<DeployResult> {
    // Amazon Linux handles all environments that use it
    return { success: true, message: 'Amazon Linux server ready' };
  }

  /**
   * Deploy to an environment
   */
  async deploy(config: FactiiiConfig, environment: string): Promise<DeployResult> {
    // Deployment is handled by the pipeline plugin
    // Server plugin just provides OS-specific commands
    return { success: true, message: `Deployment for ${environment} handled by pipeline` };
  }

  /**
   * Undeploy from an environment
   */
  async undeploy(config: FactiiiConfig, environment: string): Promise<DeployResult> {
    try {
      execSync('docker compose down', { stdio: 'inherit' });
      return { success: true, message: 'Containers stopped' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export default AmazonLinuxPlugin;
