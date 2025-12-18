/**
 * Pipeline Plugin Interface
 *
 * Base class for all pipeline plugins (GitHub Actions, GitLab CI, etc.)
 * Pipelines handle CI/CD workflows and must implement canReach() to
 * declare how they access each stage.
 */

import type {
  FactiiiConfig,
  Stage,
  Reachability,
  Fix,
  DeployResult,
} from '../../types/index.js';

/**
 * Abstract base class for pipeline plugins
 */
export abstract class PipelinePlugin {
  // ============================================================
  // REQUIRED STATIC PROPERTIES
  // ============================================================

  static readonly id: string = 'pipeline-interface';
  static readonly name: string = 'Pipeline Interface';
  static readonly category: 'pipeline' = 'pipeline';
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
   * Check if this pipeline can reach a specific stage from current environment
   *
   * @param stage - 'dev' | 'secrets' | 'staging' | 'prod'
   * @param config - factiii.yml config
   * @returns Reachability result
   */
  static canReach(_stage: Stage, _config: FactiiiConfig): Reachability {
    throw new Error('Pipeline must implement canReach()');
  }

  /**
   * Determine if this plugin should be loaded for this project
   * @param rootDir - Project root directory
   * @param config - Loaded config
   */
  static async shouldLoad(_rootDir: string, _config: FactiiiConfig): Promise<boolean> {
    throw new Error('Pipeline must implement shouldLoad()');
  }

  /**
   * Auto-detect pipeline configuration
   * @param rootDir - Project root directory
   */
  static async detectConfig(_rootDir: string): Promise<Record<string, unknown>> {
    throw new Error('Pipeline must implement detectConfig()');
  }

  // ============================================================
  // OPTIONAL STATIC METHODS
  // ============================================================

  /**
   * Generate workflow files in the target repository
   * @param rootDir - Project root directory
   */
  static async generateWorkflows(_rootDir: string): Promise<void> {
    // Optional - not all pipelines have workflow files
  }

  /**
   * Trigger a workflow
   * @param workflowName - Name of workflow to trigger
   * @param inputs - Workflow inputs
   */
  static async triggerWorkflow(
    _workflowName: string,
    _inputs: Record<string, string> = {}
  ): Promise<void> {
    throw new Error('Pipeline must implement triggerWorkflow()');
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

export default PipelinePlugin;

