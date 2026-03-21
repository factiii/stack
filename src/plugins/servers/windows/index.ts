/**
 * Windows Server Plugin
 *
 * Handles Windows-specific package management and commands.
 * Used for deploying to Windows servers or local Windows development.
 *
 * STATUS: Template - not fully implemented yet
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
  Fix,
  ServerOS,
  PackageManager,
  ServiceManager,
} from '../../../types/index.js';

// Import SSH helper
import { sshExec } from '../../../utils/ssh-helper.js';

class WindowsPlugin {
  // ============================================================
  // STATIC METADATA
  // ============================================================

  static readonly id = 'windows';
  static readonly name = 'Windows Server';
  static readonly category: 'server' = 'server';
  static readonly version = '1.0.0';

  /** The OS this server plugin handles */
  static readonly os: ServerOS = 'windows';
  /** Package manager for Windows (chocolatey) */
  static readonly packageManager: PackageManager = 'choco';
  /** Service manager for Windows */
  static readonly serviceManager: ServiceManager = 'windows-service';

  // Env vars this plugin requires
  static readonly requiredEnvVars: string[] = [];

  // Schema for stack.yml (user-editable)
  static readonly configSchema: Record<string, unknown> = {};

  // Schema for factiiiAuto.yml (auto-detected)
  static readonly autoConfigSchema: Record<string, string> = {
    ssh_user: 'string',
  };

  /**
   * Determine if this plugin should be loaded for this project
   * Loads if config has environment with server: 'windows'
   */
  static async shouldLoad(_rootDir: string, config: FactiiiConfig): Promise<boolean> {
    // Dynamic import to avoid circular dependencies
    const { extractEnvironments } = await import('../../../utils/config-helpers.js');

    const environments = extractEnvironments(config);

    for (const env of Object.values(environments)) {
      // Load if environment explicitly uses 'windows' server
      if (env.server === 'windows') {
        return true;
      }
    }

    return false;
  }

  static helpText: Record<string, string> = {
    SSH: `
   SSH/RDP credentials for accessing the Windows server.

   For SSH access, ensure OpenSSH Server is installed on Windows:
   - Settings > Apps > Optional Features > Add a feature > OpenSSH Server

   For RDP access, use Remote Desktop Connection.`,
  };

  // ============================================================
  // FIXES - All issues this plugin can detect and resolve
  // ============================================================
  // Template: Add Windows-specific fixes here
  // ============================================================

  static readonly fixes: Fix[] = [
    {
      id: 'windows-winget-missing',
      stage: 'dev',
      severity: 'critical',
      description: '📦 winget not available (required for package management)',
      scan: async (): Promise<boolean> => {
        try {
          execSync('winget --version', { stdio: 'pipe' });
          return false;
        } catch {
          return true;
        }
      },
      fix: null,
      manualFix: 'Install App Installer from Microsoft Store (includes winget)\n  Or download from: https://github.com/microsoft/winget-cli/releases',
    },
    {
      id: 'windows-docker-missing',
      stage: 'dev',
      severity: 'warning',
      description: '🐳 Docker Desktop not installed',
      scan: async (): Promise<boolean> => {
        try {
          execSync('docker --version', { stdio: 'pipe' });
          return false;
        } catch {
          return true;
        }
      },
      fix: async (): Promise<boolean> => {
        try {
          console.log('   Installing Docker Desktop via winget...');
          execSync('winget install Docker.DockerDesktop', { stdio: 'inherit' });
          return true;
        } catch {
          return false;
        }
      },
      manualFix: 'Install Docker Desktop: winget install Docker.DockerDesktop',
    },
  ];

  // ============================================================
  // STATIC HELPER METHODS
  // ============================================================

  /**
   * Auto-detect Windows configuration
   */
  static async detectConfig(_rootDir: string): Promise<{ ssh_user: string }> {
    return {
      ssh_user: 'Administrator', // Default SSH user for Windows
    };
  }

  /**
   * Execute a command on a remote server via SSH
   */
  static async sshExec(envConfig: EnvironmentConfig, command: string): Promise<string> {
    return await sshExec(envConfig, command);
  }

  // ============================================================
  // WINDOWS-SPECIFIC INSTALLATION COMMANDS
  // ============================================================

  /**
   * Get the command to install Docker on Windows
   * Requires Docker Desktop or WSL2 with Docker
   */
  static getDockerInstallCommand(): string {
    return `
      # Install Docker Desktop via Chocolatey
      choco install docker-desktop -y
      # Or install via winget
      # winget install Docker.DockerDesktop
    `;
  }

  /**
   * Get the command to install Node.js on Windows
   */
  static getNodeInstallCommand(): string {
    return 'choco install nodejs-lts -y';
  }

  /**
   * Get the command to install git on Windows
   */
  static getGitInstallCommand(): string {
    return 'choco install git -y';
  }

  /**
   * Get the command to install Chocolatey (package manager)
   */
  static getChocoInstallCommand(): string {
    return `
      Set-ExecutionPolicy Bypass -Scope Process -Force
      [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
      iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
    `;
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
    // Windows handles all environments that use it
    return { success: true, message: 'Windows server ready' };
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
    return { success: true, message: 'Windows undeploy not yet implemented' };
  }
}

export default WindowsPlugin;
