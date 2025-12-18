/**
 * Framework Plugin Interface
 *
 * Base class for all framework plugins (prisma-trpc, nextjs, expo, etc.)
 * Framework plugins handle deployment of specific application frameworks.
 */

import type {
  FactiiiConfig,
  Fix,
  DeployResult,
} from '../../types/index.js';

/**
 * Abstract base class for framework plugins
 */
export abstract class FrameworkPlugin {
  // ============================================================
  // REQUIRED STATIC PROPERTIES
  // ============================================================

  static readonly id: string = 'framework-interface';
  static readonly name: string = 'Framework Interface';
  static readonly category: 'framework' = 'framework';
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
    throw new Error('Framework plugin must implement shouldLoad()');
  }

  /**
   * Auto-detect framework configuration
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

export default FrameworkPlugin;

