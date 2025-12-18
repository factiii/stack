/**
 * Addon Plugin Interface
 *
 * Base class for all addon plugins (auth, payments, storage, etc.)
 * Addon plugins extend framework functionality.
 */

import type {
  FactiiiConfig,
  Fix,
  DeployResult,
} from '../../types/index.js';

/**
 * Abstract base class for addon plugins
 */
export abstract class AddonPlugin {
  // ============================================================
  // REQUIRED STATIC PROPERTIES
  // ============================================================

  static readonly id: string = 'addon-interface';
  static readonly name: string = 'Addon Interface';
  static readonly category: 'addon' = 'addon';
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
    throw new Error('Addon plugin must implement shouldLoad()');
  }

  /**
   * Auto-detect addon configuration
   * @param rootDir - Project root directory
   */
  static async detectConfig(_rootDir: string): Promise<Record<string, unknown>> {
    return {};
  }

  // ============================================================
  // REQUIRED INSTANCE METHODS
  // ============================================================

  /**
   * Deploy to an environment
   */
  abstract deploy(config: FactiiiConfig, environment: string): Promise<DeployResult>;

  /**
   * Undeploy from an environment
   */
  abstract undeploy(config: FactiiiConfig, environment: string): Promise<DeployResult>;
}

export default AddonPlugin;

