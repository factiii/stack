/**
 * Mac Mini Server Plugin
 *
 * Deploys containers to a Mac Mini server via SSH.
 * Typically used for staging environments (local network or Tailscale).
 * Supports dev stage for local Docker development.
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
 *   - Static metadata (id, name, category, version)
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
} from '../../../types/index.js';

// Import scanfix arrays
import { dockerFixes } from './scanfix/docker.js';
import { nodeFixes } from './scanfix/node.js';
import { gitFixes } from './scanfix/git.js';
import { containerFixes } from './scanfix/containers.js';
import { configFixes } from './scanfix/config.js';
import { certbotFixes } from './scanfix/certbot.js';

// Import environment-specific operations
import { deployDev } from './dev.js';
import { deployStaging, ensureServerReady as stagingEnsureServerReady } from './staging.js';

// Import SSH helper
import { sshExec } from '../../../utils/ssh-helper.js';

class MacMiniPlugin {
  // ============================================================
  // STATIC METADATA
  // ============================================================

  static readonly id = 'mac-mini';
  static readonly name = 'Mac Mini Server';
  static readonly category: 'server' = 'server';
  static readonly version = '1.0.0';

  // Env vars this plugin requires
  static readonly requiredEnvVars: string[] = [];

  // Schema for factiii.yml (user-editable)
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
   * Loads if config has staging host with local/private IP, or on init (no config)
   */
  static async shouldLoad(_rootDir: string, config: FactiiiConfig): Promise<boolean> {
    // Dynamic import to avoid circular dependencies
    const { extractEnvironments } = await import('../../../utils/config-helpers.js');

    const environments = extractEnvironments(config);

    for (const [name, env] of Object.entries(environments)) {
      // Load if environment explicitly uses 'mac-mini' server
      if (env.server === 'mac-mini') {
        return true;
      }

      // Load if staging environment has local/private IP
      if (name.startsWith('staging') && env.host && !env.host.startsWith('EXAMPLE-')) {
        const isLocalIp =
          /^192\.168\./.test(env.host) ||
          /^10\./.test(env.host) ||
          /^100\./.test(env.host); // Tailscale
        if (isLocalIp) return true;
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
  // ============================================================

  static readonly fixes = [
    ...dockerFixes,
    ...nodeFixes,
    ...gitFixes,
    ...containerFixes,
    ...configFixes,
    ...certbotFixes,
  ];

  // ============================================================
  // STATIC HELPER METHODS
  // ============================================================

  /**
   * Auto-detect Mac Mini configuration
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

      if (!envConfig?.host) {
        return { success: false, error: 'Staging host not configured' };
      }

      try {
        const repoName = config.name ?? 'app';
        await MacMiniPlugin.sshExec(
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

export default MacMiniPlugin;
