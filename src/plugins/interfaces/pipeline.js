/**
 * Pipeline Plugin Interface
 * 
 * Base class for all pipeline plugins (GitHub Actions, GitLab CI, etc.)
 * Pipelines handle CI/CD workflows and must implement canReach() to
 * declare how they access each stage.
 */

class PipelineInterface {
  // ============================================================
  // REQUIRED STATIC PROPERTIES
  // ============================================================
  
  static id = 'pipeline-interface';
  static name = 'Pipeline Interface';
  static category = 'pipeline';
  static version = '1.0.0';
  
  // ============================================================
  // REQUIRED INTERFACE METHODS
  // ============================================================
  
  /**
   * Check if this pipeline can reach a specific stage from current environment
   * 
   * This method MUST be implemented by all pipeline plugins. It determines
   * whether the pipeline can access a stage directly or needs to use
   * workflows/other mechanisms.
   * 
   * @param {string} stage - 'dev' | 'secrets' | 'staging' | 'prod'
   * @param {Object} config - factiii.yml config
   * @returns {Object} Reachability result:
   *   - { reachable: true, via: 'local' | 'workflow' | 'api' }
   *   - { reachable: false, reason: 'Human-readable explanation' }
   * 
   * @example
   * // Can reach locally
   * { reachable: true, via: 'local' }
   * 
   * // Can reach via workflow (must trigger workflow)
   * { reachable: true, via: 'workflow' }
   * 
   * // Can reach via API
   * { reachable: true, via: 'api' }
   * 
   * // Cannot reach - missing prerequisite
   * { reachable: false, reason: 'Missing GITHUB_TOKEN environment variable' }
   * { reachable: false, reason: 'Missing STAGING_SSH secret in GitHub' }
   */
  static canReach(stage, config) {
    throw new Error('Pipeline must implement canReach()');
  }
  
  /**
   * Determine if this plugin should be loaded for this project
   * @param {string} rootDir - Project root directory
   * @param {Object} config - Loaded config
   * @returns {Promise<boolean>}
   */
  static async shouldLoad(rootDir, config = {}) {
    throw new Error('Pipeline must implement shouldLoad()');
  }
  
  /**
   * Auto-detect pipeline configuration
   * @param {string} rootDir - Project root directory
   * @returns {Promise<Object>} Detected configuration
   */
  static async detectConfig(rootDir) {
    throw new Error('Pipeline must implement detectConfig()');
  }
  
  // ============================================================
  // OPTIONAL INTERFACE METHODS
  // ============================================================
  
  /**
   * Generate workflow files in the target repository
   * @param {string} rootDir - Project root directory
   * @returns {Promise<void>}
   */
  static async generateWorkflows(rootDir) {
    // Optional - not all pipelines have workflow files
  }
  
  /**
   * Trigger a workflow
   * @param {string} workflowName - Name of workflow to trigger
   * @param {Object} inputs - Workflow inputs
   * @returns {Promise<void>}
   */
  static async triggerWorkflow(workflowName, inputs = {}) {
    throw new Error('Pipeline must implement triggerWorkflow()');
  }
}

module.exports = PipelineInterface;
