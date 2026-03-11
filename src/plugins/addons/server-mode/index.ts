/**
 * Server Mode Addon
 *
 * Configures machines as deployment servers by:
 * - Disabling sleep/suspend
 * - Enabling SSH
 * - Configuring auto-login
 * - Setting up firewall rules
 * - Other server hardening
 *
 * This addon provides OS-specific fixes that transform a regular machine
 * into a suitable deployment target. Each OS has its own scanfix file
 * with relevant fixes.
 *
 * ============================================================
 * USAGE
 * ============================================================
 *
 * Enable in stack.yml:
 *
 * staging:
 *   domain: 192.168.1.100
 *   server: mac
 *   server_mode: true   # Enable server hardening
 *
 * Or disable (server_mode is true by default for staging/prod):
 *
 * staging:
 *   domain: 192.168.1.100
 *   server: mac
 *   server_mode: false  # Skip server hardening
 * ============================================================
 */

import type {
  FactiiiConfig,
  Fix,
  ServerOS,
} from '../../../types/index.js';

// Import OS-specific scanfix arrays
import { macFixes } from './scanfix/mac.js';
import { ubuntuFixes } from './scanfix/ubuntu.js';
import { windowsFixes } from './scanfix/windows.js';
import { tartFixes } from './scanfix/tart.js';

class ServerModeAddon {
  // ============================================================
  // STATIC METADATA
  // ============================================================

  static readonly id = 'server-mode';
  static readonly name = 'Server Mode';
  static readonly category: 'addon' = 'addon';
  static readonly version = '1.0.0';

  // Env vars this addon requires
  static readonly requiredEnvVars: string[] = [];

  // Schema for stack.yml (user-editable)
  static readonly configSchema: Record<string, unknown> = {
    // server_mode is defined per-environment in EnvironmentConfig
  };

  // Schema for factiiiAuto.yml (auto-detected)
  static readonly autoConfigSchema: Record<string, string> = {};

  /**
   * Determine if this addon should be loaded
   * Loads if any environment has server_mode enabled (or not explicitly disabled)
   */
  static async shouldLoad(_rootDir: string, config: FactiiiConfig): Promise<boolean> {
    const { extractEnvironments } = await import('../../../utils/config-helpers.js');
    const environments = extractEnvironments(config);

    // Check if any environment has server_mode enabled
    return Object.values(environments).some(env =>
      env.server_mode !== false && (env.domain || env.server)
    );
  }

  // ============================================================
  // FIXES - All issues this addon can detect and resolve
  // ============================================================
  // Organized by OS - pipeline filters by target OS
  // ============================================================

  static readonly fixes: Fix[] = [
    // Mac fixes
    ...macFixes,
    // Ubuntu fixes
    ...ubuntuFixes,
    // Windows fixes
    ...windowsFixes,
    // Tart VM infrastructure fixes
    ...tartFixes,
  ];

  // ============================================================
  // HELPER METHODS
  // ============================================================

  /**
   * Get fixes for a specific OS
   */
  static getFixesForOS(os: ServerOS): Fix[] {
    return ServerModeAddon.fixes.filter(fix => {
      if (!fix.os) return true; // No OS filter = applies to all
      if (Array.isArray(fix.os)) return fix.os.includes(os);
      return fix.os === os;
    });
  }

  // ============================================================
  // INSTANCE METHODS
  // ============================================================

  private _config: FactiiiConfig;

  constructor(config: FactiiiConfig) {
    this._config = config;
  }
}

export default ServerModeAddon;
