/**
 * Ubuntu Server Plugin
 *
 * Handles Ubuntu-specific package management and commands.
 * Used for deploying to Ubuntu servers (EC2, DigitalOcean, Linode, etc.)
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

class UbuntuPlugin {
  // ============================================================
  // STATIC METADATA
  // ============================================================

  static readonly id = 'ubuntu';
  static readonly name = 'Ubuntu Server';
  static readonly category: 'server' = 'server';
  static readonly version = '1.0.0';

  /** The OS this server plugin handles */
  static readonly os: ServerOS = 'ubuntu';
  /** Package manager for Ubuntu */
  static readonly packageManager: PackageManager = 'apt';
  /** Service manager for Ubuntu */
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
   * Loads if config has environment with server: 'ubuntu'
   */
  static async shouldLoad(_rootDir: string, config: FactiiiConfig): Promise<boolean> {
    // Dynamic import to avoid circular dependencies
    const { extractEnvironments } = await import('../../../utils/config-helpers.js');

    const environments = extractEnvironments(config);

    for (const env of Object.values(environments)) {
      // Load if environment explicitly uses 'ubuntu' server
      if (env.server === 'ubuntu') {
        return true;
      }
    }

    return false;
  }

  static helpText: Record<string, string> = {
    SSH: `
   SSH private key for accessing the Ubuntu server.

   Step 1: Generate a new SSH key pair (if needed):
   ssh-keygen -t ed25519 -C "deploy-key" -f ~/.ssh/deploy_key

   Step 2: Add PUBLIC key to server:
   ssh-copy-id -i ~/.ssh/deploy_key.pub ubuntu@YOUR_HOST

   Step 3: Paste the PRIVATE key below (multi-line, end with blank line):
   cat ~/.ssh/deploy_key`,
  };

  // ============================================================
  // FIXES - All issues this plugin can detect and resolve
  // ============================================================
  // All fixes are OS-specific to Ubuntu
  // ============================================================

  static readonly fixes = [
    // Dev stage - shared fixes (with OS filter)
    ...getDockerFixes('dev').map(fix => ({ ...fix, os: 'ubuntu' as ServerOS })),

    // Staging stage - shared fixes (with OS filter)
    ...getDockerFixes('staging').map(fix => ({ ...fix, os: 'ubuntu' as ServerOS })),
    ...getNodeFixes('staging').map(fix => ({ ...fix, os: 'ubuntu' as ServerOS })),
    ...getGitFixes('staging').map(fix => ({ ...fix, os: 'ubuntu' as ServerOS })),
    ...getPnpmFixes('staging').map(fix => ({ ...fix, os: 'ubuntu' as ServerOS })),
    { ...createCertbotFix('staging', 'staging'), os: 'ubuntu' as ServerOS },

    // Prod stage - shared fixes (with OS filter)
    ...getDockerFixes('prod').map(fix => ({ ...fix, os: 'ubuntu' as ServerOS })),
    ...getNodeFixes('prod').map(fix => ({ ...fix, os: 'ubuntu' as ServerOS })),
    ...getGitFixes('prod').map(fix => ({ ...fix, os: 'ubuntu' as ServerOS })),
    { ...createCertbotFix('prod', 'prod'), os: 'ubuntu' as ServerOS },
  ];

  // ============================================================
  // STATIC HELPER METHODS
  // ============================================================

  /**
   * Auto-detect Ubuntu configuration
   */
  static async detectConfig(_rootDir: string): Promise<{ ssh_user: string }> {
    return {
      ssh_user: 'ubuntu', // Default SSH user for Ubuntu
    };
  }

  /**
   * Execute a command on a remote server via SSH
   */
  static async sshExec(envConfig: EnvironmentConfig, command: string): Promise<string> {
    return await sshExec(envConfig, command);
  }

  // ============================================================
  // UBUNTU-SPECIFIC INSTALLATION COMMANDS
  // ============================================================

  /**
   * Get the command to install Docker on Ubuntu
   */
  static getDockerInstallCommand(): string {
    return `
      sudo apt-get update && \
      sudo apt-get install -y ca-certificates curl gnupg && \
      sudo install -m 0755 -d /etc/apt/keyrings && \
      curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
      sudo chmod a+r /etc/apt/keyrings/docker.gpg && \
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null && \
      sudo apt-get update && \
      sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin && \
      sudo usermod -aG docker $USER
    `;
  }

  /**
   * Get the command to install Node.js on Ubuntu
   */
  static getNodeInstallCommand(): string {
    return `
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && \
      sudo apt-get install -y nodejs
    `;
  }

  /**
   * Get the command to install git on Ubuntu
   */
  static getGitInstallCommand(): string {
    return 'sudo apt-get update && sudo apt-get install -y git';
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
    // Ubuntu handles all environments that use it
    return { success: true, message: 'Ubuntu server ready' };
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

export default UbuntuPlugin;
