/**
 * Base class for Pipeline plugins
 * 
 * Pipelines define how code flows from dev → staging → production.
 * They generate CI/CD configuration files and handle workflow triggers.
 * 
 * Examples: github-actions, gitlab-ci, jenkins, manual
 */
class Pipeline {
  // ============================================================
  // STATIC METADATA - Override in subclasses
  // ============================================================
  
  /** Unique plugin identifier (e.g., 'github-actions', 'gitlab-ci') */
  static id = 'base-pipeline';
  
  /** Human-readable name (e.g., 'GitHub Actions', 'GitLab CI') */
  static name = 'Base Pipeline';
  
  /** Plugin category - always 'pipeline' for pipelines */
  static category = 'pipeline';
  
  /** Plugin version */
  static version = '1.0.0';
  
  /**
   * Required secrets this pipeline needs
   * @type {Array<{name: string, type: string, description: string}>}
   */
  static requiredSecrets = [];
  
  /**
   * Settings this pipeline adds to factiii.yml
   * @type {Object}
   */
  static factiiiYmlSettings = {};
  
  /**
   * Workflow files this pipeline generates
   * @type {string[]}
   */
  static generatedFiles = [];
  
  // ============================================================
  // CONSTRUCTOR
  // ============================================================
  
  /**
   * @param {Object} config - Pipeline configuration from factiii.yml
   */
  constructor(config = {}) {
    this.config = config;
  }
  
  // ============================================================
  // INIT PATTERN - Scan for issues
  // ============================================================
  
  /**
   * Scan local environment for pipeline requirements
   * 
   * @param {Object} config - Project configuration
   * @returns {Promise<{issues: Array<{type: string, message: string, fix?: string}>, passed: number}>}
   */
  async scanDev(config) {
    throw new Error('scanDev() must be implemented by subclass');
  }
  
  /**
   * Scan CI/CD platform for configuration
   * 
   * @param {Object} config - Project configuration
   * @returns {Promise<{issues: Array<{type: string, message: string, fix?: string}>, passed: number}>}
   */
  async scanPlatform(config) {
    throw new Error('scanPlatform() must be implemented by subclass');
  }
  
  // ============================================================
  // INIT FIX PATTERN - Fix issues
  // ============================================================
  
  /**
   * Fix local issues (generate workflow files)
   * 
   * @param {Array} issues - Issues from scanDev
   * @returns {Promise<{fixed: string[], failed: string[]}>}
   */
  async fixDev(issues) {
    throw new Error('fixDev() must be implemented by subclass');
  }
  
  /**
   * Fix platform issues (configure secrets, webhooks, etc.)
   * 
   * @param {Array} issues - Issues from scanPlatform
   * @returns {Promise<{fixed: string[], failed: string[]}>}
   */
  async fixPlatform(issues) {
    throw new Error('fixPlatform() must be implemented by subclass');
  }
  
  // ============================================================
  // WORKFLOW GENERATION
  // ============================================================
  
  /**
   * Generate workflow files for the project
   * 
   * @param {Object} config - Project configuration
   * @param {string} outputDir - Output directory for workflow files
   * @returns {Promise<{created: string[], updated: string[], unchanged: string[]}>}
   */
  async generateWorkflows(config, outputDir) {
    throw new Error('generateWorkflows() must be implemented by subclass');
  }
  
  /**
   * Get workflow template for a specific stage
   * 
   * @param {string} stage - Workflow stage ('staging', 'production', 'deploy', 'undeploy')
   * @param {Object} config - Project configuration
   * @returns {string} - Workflow file content
   */
  getWorkflowTemplate(stage, config) {
    throw new Error('getWorkflowTemplate() must be implemented by subclass');
  }
  
  // ============================================================
  // DEPLOY PATTERN
  // ============================================================
  
  /**
   * Trigger a deployment workflow
   * 
   * @param {string} environment - Target environment ('staging', 'production')
   * @param {Object} options - Deployment options
   * @returns {Promise<{success: boolean, runId?: string, url?: string, error?: string}>}
   */
  async triggerDeploy(environment, options = {}) {
    throw new Error('triggerDeploy() must be implemented by subclass');
  }
  
  /**
   * Wait for a workflow run to complete
   * 
   * @param {string} runId - Workflow run ID
   * @param {number} timeoutSeconds - Maximum wait time
   * @returns {Promise<{completed: boolean, success: boolean, conclusion?: string, error?: string}>}
   */
  async waitForCompletion(runId, timeoutSeconds = 600) {
    throw new Error('waitForCompletion() must be implemented by subclass');
  }
  
  /**
   * Get status of a workflow run
   * 
   * @param {string} runId - Workflow run ID
   * @returns {Promise<{status: string, conclusion?: string, url?: string, error?: string}>}
   */
  async getRunStatus(runId) {
    throw new Error('getRunStatus() must be implemented by subclass');
  }
  
  // ============================================================
  // HELPER METHODS
  // ============================================================
  
  /**
   * Check if workflow files exist and are up to date
   * 
   * @param {string} workflowDir - Workflow directory path
   * @returns {{exists: boolean, files: string[], outdated: string[]}}
   */
  checkWorkflowFiles(workflowDir) {
    const fs = require('fs');
    const path = require('path');
    const result = { exists: false, files: [], outdated: [] };
    
    if (!fs.existsSync(workflowDir)) {
      return result;
    }
    
    result.exists = true;
    
    for (const expectedFile of this.constructor.generatedFiles) {
      const filePath = path.join(workflowDir, expectedFile);
      
      if (fs.existsSync(filePath)) {
        result.files.push(expectedFile);
        // TODO: Check if file is outdated by comparing with template
      } else {
        result.outdated.push(expectedFile);
      }
    }
    
    return result;
  }
}

module.exports = Pipeline;


