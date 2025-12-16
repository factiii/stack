/**
 * Base class for Addon plugins
 * 
 * Addons extend base frameworks with validation and enhanced functionality.
 * They don't deploy independently - they validate and enhance the frameworks they attach to.
 * 
 * Examples: auth, payments, storage, email, notifications
 */
class Addon {
  // ============================================================
  // STATIC METADATA - Override in subclasses
  // ============================================================
  
  /** Unique plugin identifier (e.g., 'auth', 'payments') */
  static id = 'base-addon';
  
  /** Human-readable name (e.g., 'Authentication', 'Payments') */
  static name = 'Base Addon';
  
  /** Plugin category - always 'addon' for addons */
  static category = 'addon';
  
  /** Plugin version */
  static version = '1.0.0';
  
  /**
   * Which frameworks this addon can extend
   * @type {string[]}
   */
  static compatibleWith = [];
  
  /**
   * Schema requirements (for Prisma-based frameworks)
   * @type {{models?: string[], fields?: Object<string, string[]>}}
   */
  static schemaRequirements = {
    models: [],
    fields: {}
  };
  
  /**
   * Route requirements (for tRPC-based frameworks)
   * @type {string[]}
   */
  static routeRequirements = [];
  
  /**
   * Required secrets this addon needs
   * @type {string[]}
   */
  static requiredSecrets = [];
  
  /**
   * Settings this addon adds to factiii.yml
   * @type {Object}
   */
  static factiiiYmlSettings = {};
  
  /**
   * Settings this addon adds to factiiiAuto.yml
   * @type {Object}
   */
  static factiiiAutoSettings = {};
  
  // ============================================================
  // CONSTRUCTOR
  // ============================================================
  
  /**
   * @param {Object} config - Addon configuration from factiii.yml
   * @param {Object} frameworkConfig - Parent framework configuration
   */
  constructor(config = {}, frameworkConfig = {}) {
    this.config = config;
    this.frameworkConfig = frameworkConfig;
  }
  
  // ============================================================
  // INIT PATTERN - Scan for issues
  // ============================================================
  
  /**
   * Scan local development environment for addon requirements
   * 
   * @param {Object} config - Project configuration
   * @returns {Promise<{issues: Array<{type: string, message: string, fix?: string}>, passed: number}>}
   */
  async scanDev(config) {
    throw new Error('scanDev() must be implemented by subclass');
  }
  
  /**
   * Scan GitHub for addon-specific secrets
   * 
   * @param {Object} config - Project configuration
   * @returns {Promise<{issues: Array<{type: string, message: string, fix?: string}>, passed: number}>}
   */
  async scanGitHub(config) {
    const issues = [];
    let passed = 0;
    
    // Check required secrets exist
    for (const secret of this.constructor.requiredSecrets) {
      // This would check GitHub API
      // For now, return as issue to be checked
      issues.push({
        type: 'warning',
        message: `Addon requires secret: ${secret}`,
        fix: `npx factiii init fix`
      });
    }
    
    return { issues, passed };
  }
  
  // ============================================================
  // INIT FIX PATTERN - Fix issues
  // ============================================================
  
  /**
   * Fix local development issues for this addon
   * 
   * @param {Array} issues - Issues from scanDev
   * @returns {Promise<{fixed: string[], failed: string[]}>}
   */
  async fixDev(issues) {
    throw new Error('fixDev() must be implemented by subclass');
  }
  
  /**
   * Fix GitHub issues (upload secrets)
   * 
   * @param {Array} issues - Issues from scanGitHub
   * @param {Object} secretStore - Secret store instance
   * @returns {Promise<{fixed: string[], failed: string[]}>}
   */
  async fixGitHub(issues, secretStore) {
    // Default implementation - subclasses can override
    return { fixed: [], failed: [] };
  }
  
  // ============================================================
  // VALIDATION METHODS
  // ============================================================
  
  /**
   * Validate Prisma schema has required models and fields
   * 
   * @param {string} schemaPath - Path to schema.prisma
   * @returns {{valid: boolean, missing: {models: string[], fields: Object<string, string[]>}}}
   */
  validateSchema(schemaPath) {
    const fs = require('fs');
    const result = {
      valid: true,
      missing: { models: [], fields: {} }
    };
    
    if (!fs.existsSync(schemaPath)) {
      result.valid = false;
      result.missing.models = this.constructor.schemaRequirements.models || [];
      return result;
    }
    
    const schemaContent = fs.readFileSync(schemaPath, 'utf8');
    
    // Check required models
    for (const model of (this.constructor.schemaRequirements.models || [])) {
      const modelRegex = new RegExp(`model\\s+${model}\\s*\\{`, 'i');
      if (!modelRegex.test(schemaContent)) {
        result.valid = false;
        result.missing.models.push(model);
      }
    }
    
    // Check required fields for each model
    for (const [model, fields] of Object.entries(this.constructor.schemaRequirements.fields || {})) {
      const modelMatch = schemaContent.match(new RegExp(`model\\s+${model}\\s*\\{([^}]+)\\}`, 'is'));
      
      if (!modelMatch) {
        result.missing.fields[model] = fields;
        result.valid = false;
        continue;
      }
      
      const modelBody = modelMatch[1];
      const missingFields = [];
      
      for (const field of fields) {
        const fieldRegex = new RegExp(`\\b${field}\\b`, 'i');
        if (!fieldRegex.test(modelBody)) {
          missingFields.push(field);
        }
      }
      
      if (missingFields.length > 0) {
        result.missing.fields[model] = missingFields;
        result.valid = false;
      }
    }
    
    return result;
  }
  
  /**
   * Validate tRPC routes exist
   * 
   * @param {string} routerPath - Path to tRPC router directory
   * @returns {{valid: boolean, missing: string[]}}
   */
  validateRoutes(routerPath) {
    const fs = require('fs');
    const path = require('path');
    const result = { valid: true, missing: [] };
    
    if (!fs.existsSync(routerPath)) {
      result.valid = false;
      result.missing = this.constructor.routeRequirements || [];
      return result;
    }
    
    // Read all router files
    let routerContent = '';
    const files = fs.readdirSync(routerPath);
    
    for (const file of files) {
      if (file.endsWith('.ts') || file.endsWith('.js')) {
        routerContent += fs.readFileSync(path.join(routerPath, file), 'utf8');
      }
    }
    
    // Check required routes
    for (const route of (this.constructor.routeRequirements || [])) {
      // Check for route definition (e.g., 'auth.login' -> 'login:' or '.login(')
      const routeName = route.split('.').pop();
      const routeRegex = new RegExp(`['"]?${routeName}['"]?\\s*[:|(]`, 'i');
      
      if (!routeRegex.test(routerContent)) {
        result.valid = false;
        result.missing.push(route);
      }
    }
    
    return result;
  }
  
  // ============================================================
  // DEPLOY PATTERN
  // ============================================================
  
  /**
   * Pre-deploy validation
   * Called before the parent framework deploys
   * 
   * @param {Object} envConfig - Environment configuration
   * @returns {Promise<{ready: boolean, errors: string[]}>}
   */
  async preDeployValidation(envConfig) {
    return { ready: true, errors: [] };
  }
  
  /**
   * Post-deploy setup
   * Called after the parent framework deploys
   * 
   * @param {Object} envConfig - Environment configuration
   * @returns {Promise<{success: boolean, message?: string, error?: string}>}
   */
  async postDeploySetup(envConfig) {
    return { success: true };
  }
}

module.exports = Addon;

