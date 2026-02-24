/**
 * Mac Server Plugin
 *
 * Handles macOS-specific package management and commands.
 * Used for deploying to Mac servers or local Mac development.
 *
 * ============================================================
 * PLUGIN STRUCTURE STANDARD
 * ============================================================
 *
 * This plugin follows a standardized structure for clarity and maintainability:
 *
 * **scanfix/** - Scan/fix operations organized by concern
 *   - Each file exports an array of Fix[] objects
 *   - Files group related fixes together (docker, node, git, containers, config)
 *   - All fixes are combined in the main plugin class
 *
 * **Environment-specific files** - Operations for each environment
 *   - dev.ts - Dev environment operations (deployDev)
 *   - staging.ts - Staging operations (deployStaging, ensureServerReady)
 *   - Only create files if they have content (no blank files)
 *
 * **index.ts** - Main plugin class
 *   - Static metadata (id, name, category, version, os, packageManager, serviceManager)
 *   - shouldLoad() - Determines if plugin should load
 *   - Imports and combines all scanfix arrays
 *   - Imports and uses environment-specific methods
 *   - Maintains public API compatibility
 *
 * **When each environment file is used:**
 *   - dev.ts: When deploying to local dev environment
 *   - staging.ts: When deploying to staging server or preparing staging server
 *
 * **How scanfix files are organized:**
 *   - docker.ts: Docker installation, running status, autostart (dev + staging)
 *   - node.ts: Node.js and pnpm installation (staging)
 *   - git.ts: Git installation (staging)
 *   - containers.ts: Container management and cleanup (staging)
 *   - config.ts: Configuration checks and file validation (dev + staging)
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

// Import plugin-specific scanfix arrays
import { containerFixes } from './scanfix/containers.js';
import { configFixes } from './scanfix/config.js';
import { systemFixes } from './scanfix/system.js';

// Import environment-specific operations
import { deployDev } from './dev.js';
import { deployStaging, ensureServerReady as stagingEnsureServerReady } from './staging.js';

// Import SSH helper
import { sshExec } from '../../../utils/ssh-helper.js';

class MacPlugin {
  // ============================================================
  // STATIC METADATA
  // ============================================================

  static readonly id = 'mac';
  static readonly name = 'Mac Server';
  static readonly category: 'server' = 'server';
  static readonly version = '1.0.0';

  /** The OS this server plugin handles */
  static readonly os: ServerOS = 'mac';
  /** Package manager for macOS */
  static readonly packageManager: PackageManager = 'brew';
  /** Service manager for macOS */
  static readonly serviceManager: ServiceManager = 'launchctl';

  // Env vars this plugin requires
  static readonly requiredEnvVars: string[] = [];

  // Schema for stack.yml (user-editable)
  static readonly configSchema: Record<string, unknown> = {
    // No user config needed - uses staging.host
    container_exclusions: 'array of container names to exclude from cleanup',
  };

  // Schema for factiiiAuto.yml (auto-detected)
  static readonly autoConfigSchema: Record<string, string> = {
    ssh_user: 'string',
  };

  /**
   * Determine if this plugin should be loaded for this project
   * Loads if config has environment with server: 'mac'
   */
  static async shouldLoad(_rootDir: string, config: FactiiiConfig): Promise<boolean> {
    // Dynamic import to avoid circular dependencies
    const { extractEnvironments } = await import('../../../utils/config-helpers.js');

    const environments = extractEnvironments(config);

    for (const [name, env] of Object.entries(environments)) {
      // Load if environment explicitly uses 'mac'
      if (env.server === 'mac' || (env.server as string) === 'mac-mini') {
        return true;
      }

      // Load if staging environment has local/private IP or staging domain
      if (name.startsWith('staging') && env.domain && !env.domain.startsWith('EXAMPLE-')) {
        const isLocal =
          /^192\.168\./.test(env.domain) ||
          /^10\./.test(env.domain) ||
          /^100\./.test(env.domain) || // Tailscale
          env.domain.includes('staging');
        if (isLocal) return true;
      }
    }

    // On init (no config or EXAMPLE values), load as default staging option
    return Object.keys(config).length === 0;
  }

  static helpText: Record<string, string> = {
    SSH: `
   SSH private key for accessing the server.

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
  // Combined from scanfix/ folder files
  // All fixes are OS-specific to Mac
  // ============================================================

  static readonly fixes = [
    // Dev stage - shared fixes (with OS filter)
    ...getDockerFixes('dev').map(fix => ({ ...fix, os: 'mac' as ServerOS })),

    // Staging stage - shared fixes (with OS filter)
    ...getDockerFixes('staging').map(fix => ({ ...fix, os: 'mac' as ServerOS })),
    ...getNodeFixes('staging').map(fix => ({ ...fix, os: 'mac' as ServerOS })),
    ...getGitFixes('staging').map(fix => ({ ...fix, os: 'mac' as ServerOS })),
    ...getPnpmFixes('staging').map(fix => ({ ...fix, os: 'mac' as ServerOS })),
    { ...createCertbotFix('staging', 'staging'), os: 'mac' as ServerOS },

    // Plugin-specific fixes (with OS filter)
    ...containerFixes.map(fix => ({ ...fix, os: 'mac' as ServerOS })),
    ...configFixes.map(fix => ({ ...fix, os: 'mac' as ServerOS })),
    ...systemFixes.map(fix => ({ ...fix, os: 'mac' as ServerOS })),
  ];

  // ============================================================
  // STATIC HELPER METHODS
  // ============================================================

  /**
   * Auto-detect macOS configuration
   */
  static async detectConfig(_rootDir: string): Promise<{ ssh_user: string }> {
    return {
      ssh_user: 'ubuntu', // Default SSH user
    };
  }

  /**
   * Execute a command on a remote server via SSH
   */
  static async sshExec(envConfig: EnvironmentConfig, command: string): Promise<string> {
    return await sshExec(envConfig, command);
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
   * Installs Node.js, git, pnpm, clones repo, checks out commit
   */
  async ensureServerReady(
    config: FactiiiConfig,
    environment: string,
    options: EnsureServerReadyOptions = {}
  ): Promise<DeployResult> {
    return stagingEnsureServerReady(config, environment, options);
  }

  /**
   * Deploy to an environment
   */
  async deploy(config: FactiiiConfig, environment: string): Promise<DeployResult> {
    if (environment === 'dev') {
      return deployDev();
    } else if (environment === 'staging') {
      return deployStaging(config);
    }

    return { success: false, error: `Unsupported environment: ${environment}` };
  }

  /**
   * Undeploy from an environment
   */
  async undeploy(config: FactiiiConfig, environment: string): Promise<DeployResult> {
    if (environment === 'dev') {
      try {
        execSync('docker compose down', { stdio: 'inherit' });
        return { success: true, message: 'Local containers stopped' };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } else if (environment === 'staging') {
      const { extractEnvironments } = await import('../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);
      const envConfig = environments.staging;

      if (!envConfig?.domain) {
        return { success: false, error: 'Staging domain not configured' };
      }

      try {
        const repoName = config.name ?? 'app';
        await MacPlugin.sshExec(
          envConfig,
          `
          cd ~/.factiii && docker compose stop ${repoName}-staging
        `
        );
        return { success: true, message: 'Staging containers stopped' };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return { success: false, error: `Unsupported environment: ${environment}` };
  }
}

export default MacPlugin;
