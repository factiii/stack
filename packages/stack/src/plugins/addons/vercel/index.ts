/**
 * Vercel Addon Plugin
 *
 * Cloud hosting addon for deploying to Vercel via factiii pipeline.
 * Uses Vercel REST API exclusively (no CLI required).
 *
 * This is an ADDON plugin that extends factiii pipeline. It handles:
 * - Vercel deployment orchestration
 * - Project linking and configuration
 * - Domain management
 *
 * ============================================================
 * API-Only Architecture
 * ============================================================
 *
 * All operations use the Vercel REST API:
 * - Deploying (git-push triggers, status checks)
 * - Project creation and linking
 * - Listing projects/deployments
 * - Token management via Ansible Vault
 *
 * No Vercel CLI is required or installed.
 *
 * ============================================================
 * PLUGIN STRUCTURE STANDARD
 * ============================================================
 *
 * **scanfix/** - Scan/fix operations organized by concern
 *   - config.ts - Vercel project configuration + framework detection
 *   - token.ts - VERCEL_TOKEN management
 *
 * **utils/** - Vercel API helpers
 *   - vercel-api.ts - API client and helpers
 *
 * **index.ts** - Main plugin class
 *   - Static metadata (id, name, category, version)
 *   - Imports and combines all scanfix arrays
 * ============================================================
 */

import type {
  FactiiiConfig,
  EnvironmentConfig,
  DeployResult,
  Fix,
  Stage,
  Reachability,
  ServerOS,
} from '../../../types/index.js';

// Import scanfixes
import { fixes as configFixes } from './scanfix/config.js';
import { fixes as tokenFixes } from './scanfix/token.js';
import { dnsFixes } from './scanfix/dns.js';
import { domainFixes } from './scanfix/domain.js';

class VercelAddon {
  // ============================================================
  // STATIC METADATA
  // ============================================================

  static readonly id = 'vercel';
  static readonly name = 'Vercel Addon';
  static readonly category: 'addon' = 'addon';
  static readonly version = '1.0.0';

  /**
   * Server OS types this pipeline is compatible with
   * Vercel is serverless, but we support all dev machine types
   */
  static readonly compatibleServers: ServerOS[] = ['mac', 'ubuntu', 'windows'];

  /**
   * Default server (N/A for Vercel - serverless)
   */
  static readonly defaultServer: ServerOS = 'ubuntu';

  // Env vars this plugin requires
  static readonly requiredEnvVars: string[] = ['VERCEL_TOKEN'];

  // Schema for stack.yml (user-editable)
  static readonly configSchema: Record<string, unknown> = {
    vercel: {
      project_name: 'EXAMPLE_my-project',
      org_id: 'EXAMPLE_team_xxx',
      project_id: 'EXAMPLE_prj_xxx',
    },
  };

  // Schema for stackAuto.yml (auto-detected)
  static readonly autoConfigSchema: Record<string, string> = {
    vercel_project_linked: 'boolean',
  };

  /**
   * Determine if this plugin should be loaded for this project
   * Loads if vercel config exists (factiii pipeline will use this addon as needed)
   */
  static async shouldLoad(_rootDir: string, config: FactiiiConfig): Promise<boolean> {
    // Load if vercel section exists at all (even empty vercel: {})
    if (config.vercel !== undefined) {
      return true;
    }

    // Load if vercel section exists in any environment
    const { extractEnvironments } = await import('../../../utils/config-helpers.js');
    const environments = extractEnvironments(config);

    for (const env of Object.values(environments)) {
      if ((env as { vercel?: unknown }).vercel) {
        return true;
      }
    }

    return false;
  }

  static helpText: Record<string, string> = {
    VERCEL_TOKEN: `
   Vercel API Token for deployments.

   Get from: https://vercel.com/account/tokens

   Create a new token with:
   - Scope: Full Account (or specific team)
   - Expiration: No Expiration (or custom)

   The token will be stored securely in Ansible Vault.`,
  };

  // ============================================================
  // PIPELINE-SPECIFIC METHODS
  // ============================================================

  /**
   * Check if Vercel is configured and available
   * (Called by factiii pipeline to determine if Vercel deployment is possible)
   */
  static isVercelConfigured(config: FactiiiConfig): boolean {
    // Check if vercel config exists
    if (config.vercel?.project_name) {
      return true;
    }
    return false;
  }

  // ============================================================
  // FIXES - All issues this plugin can detect and resolve
  // ============================================================

  static readonly fixes: Fix[] = [
    ...configFixes,
    ...tokenFixes,
    ...dnsFixes,
    ...domainFixes,
  ];

  // ============================================================
  // STATIC HELPER METHODS
  // ============================================================

  /**
   * Auto-detect Vercel configuration
   */
  static async detectConfig(rootDir: string): Promise<Record<string, unknown>> {
    const detected: Record<string, unknown> = {};

    // Check if project is linked (.vercel/project.json)
    try {
      const fs = await import('fs');
      const path = await import('path');
      const vercelConfigPath = path.join(rootDir, '.vercel', 'project.json');
      if (fs.existsSync(vercelConfigPath)) {
        detected.vercel_project_linked = true;
      } else {
        detected.vercel_project_linked = false;
      }
    } catch {
      detected.vercel_project_linked = false;
    }

    return detected;
  }

  // ============================================================
  // INSTANCE METHODS
  // ============================================================

  private _config: FactiiiConfig;

  constructor(config: FactiiiConfig) {
    this._config = config;
  }

  /**
   * Deploy to Vercel (called by factiii pipeline)
   */
  static async deployToVercel(
    config: FactiiiConfig,
    options: { production?: boolean; branch?: string; commit?: string } = {}
  ): Promise<DeployResult> {
    const { deployToVercel } = await import('./utils/vercel-api.js');
    return deployToVercel(config, options);
  }

  /**
   * Deploy to an environment
   */
  async deploy(config: FactiiiConfig, environment: string): Promise<DeployResult> {
    const { deployToVercel } = await import('./utils/vercel-api.js');

    const production = environment === 'prod';
    return deployToVercel(config, { production });
  }

  /**
   * Undeploy is not applicable for Vercel (serverless)
   */
  async undeploy(_config: FactiiiConfig, _environment: string): Promise<DeployResult> {
    return {
      success: false,
      error: 'Undeploy not supported for Vercel. Deployments are immutable. Use Vercel dashboard to delete.',
    };
  }
}

export default VercelAddon;
