/**
 * Base class for App Framework plugins
 * 
 * App framework plugins auto-detect and configure:
 * - Next.js
 * - Expo
 * - React Native
 * - Node.js API servers
 * - etc.
 */
class AppFramework {
  // ============================================================
  // STATIC METADATA - Override in subclasses
  // ============================================================
  
  /** Unique plugin identifier (e.g., 'nextjs', 'expo', 'node-api') */
  static id = 'base-app';
  
  /** Human-readable name */
  static name = 'Base App Framework';
  
  /** Plugin category - always 'app' for app frameworks */
  static category = 'app';
  
  /** Plugin version */
  static version = '1.0.0';
  
  /**
   * Files/patterns that indicate this framework is in use
   * Used for auto-detection
   * @type {string[]}
   */
  static detectionPatterns = [];
  
  /**
   * Default Dockerfile template for this framework
   * @type {string}
   */
  static defaultDockerfile = '';
  
  /**
   * Default port this framework uses
   * @type {number}
   */
  static defaultPort = 3000;
  
  /**
   * Default health check endpoint
   * @type {string}
   */
  static defaultHealthCheck = '/health';
  
  /**
   * Build commands for this framework
   * @type {{install: string, build: string, start: string}}
   */
  static buildCommands = {
    install: 'npm install',
    build: 'npm run build',
    start: 'npm start'
  };
  
  // ============================================================
  // CONSTRUCTOR
  // ============================================================
  
  /**
   * @param {string} appPath - Path to the app directory
   * @param {Object} config - App configuration from core.yml
   */
  constructor(appPath, config = {}) {
    this.appPath = appPath;
    this.config = config;
  }
  
  // ============================================================
  // STATIC METHODS - Detection
  // ============================================================
  
  /**
   * Detect if this framework is used in the given directory
   * 
   * @param {string} dirPath - Directory to check
   * @returns {Promise<{detected: boolean, confidence: number, details?: Object}>}
   */
  static async detect(dirPath) {
    const fs = require('fs');
    const path = require('path');
    
    let matchCount = 0;
    const details = {};
    
    for (const pattern of this.detectionPatterns) {
      const fullPath = path.join(dirPath, pattern);
      if (fs.existsSync(fullPath)) {
        matchCount++;
        details[pattern] = true;
      }
    }
    
    const confidence = this.detectionPatterns.length > 0
      ? matchCount / this.detectionPatterns.length
      : 0;
    
    return {
      detected: confidence > 0,
      confidence,
      details
    };
  }
  
  // ============================================================
  // REQUIRED METHODS - Must be implemented by subclasses
  // ============================================================
  
  /**
   * Generate Dockerfile for this app
   * 
   * @returns {Promise<{dockerfile: string, error?: string}>}
   */
  async generateDockerfile() {
    throw new Error('generateDockerfile() must be implemented by subclass');
  }
  
  /**
   * Get environment variables required for this framework
   * 
   * @param {string} environment - Environment name (staging, production)
   * @returns {Promise<{envVars: Object, error?: string}>}
   */
  async getRequiredEnvVars(environment) {
    throw new Error('getRequiredEnvVars() must be implemented by subclass');
  }
  
  // ============================================================
  // OPTIONAL METHODS - Can be overridden by subclasses
  // ============================================================
  
  /**
   * Validate app configuration
   * 
   * @returns {Promise<{valid: boolean, errors?: string[], warnings?: string[]}>}
   */
  async validate() {
    return { valid: true, errors: [], warnings: [] };
  }
  
  /**
   * Get build arguments for Docker
   * 
   * @param {string} environment - Environment name
   * @returns {Promise<{args: Object, error?: string}>}
   */
  async getBuildArgs(environment) {
    return { args: {} };
  }
  
  /**
   * Get the port this app listens on
   * 
   * @returns {number}
   */
  getPort() {
    return this.config.port || this.constructor.defaultPort;
  }
  
  /**
   * Get health check endpoint
   * 
   * @returns {string}
   */
  getHealthCheckEndpoint() {
    return this.config.health_check || this.constructor.defaultHealthCheck;
  }
  
  /**
   * Pre-build hook (runs before Docker build)
   * 
   * @param {string} environment - Environment name
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async preBuild(environment) {
    return { success: true };
  }
  
  /**
   * Post-deploy hook (runs after successful deploy)
   * 
   * @param {string} environment - Environment name
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async postDeploy(environment) {
    return { success: true };
  }
}

module.exports = AppFramework;

