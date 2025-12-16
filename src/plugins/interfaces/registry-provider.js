/**
 * Base class for Container Registry plugins
 * 
 * Registry providers handle Docker image storage:
 * - AWS ECR
 * - Docker Hub
 * - Google Container Registry (GCR)
 * - GitHub Container Registry (GHCR)
 */
class RegistryProvider {
  // ============================================================
  // STATIC METADATA - Override in subclasses
  // ============================================================
  
  /** Unique plugin identifier (e.g., 'ecr', 'dockerhub', 'gcr') */
  static id = 'base-registry';
  
  /** Human-readable name */
  static name = 'Base Registry Provider';
  
  /** Plugin category - always 'registry' for registry providers */
  static category = 'registry';
  
  /** Plugin version */
  static version = '1.0.0';
  
  /**
   * Required secrets for authentication
   * @type {Array<{name: string, type: string, description?: string}>}
   */
  static requiredSecrets = [];
  
  /**
   * Capabilities of this registry
   */
  static capabilities = {
    /** Supports private repositories */
    private: true,
    /** Supports image scanning */
    scanning: false,
    /** Supports lifecycle policies */
    lifecycle: false,
    /** Supports cross-region replication */
    replication: false
  };
  
  // ============================================================
  // CONSTRUCTOR
  // ============================================================
  
  /**
   * @param {Object} config - Plugin configuration
   * @param {Object} secrets - Authentication secrets
   */
  constructor(config = {}, secrets = {}) {
    this.config = config;
    this.secrets = secrets;
  }
  
  // ============================================================
  // REQUIRED METHODS - Must be implemented by subclasses
  // ============================================================
  
  /**
   * Get Docker login command for this registry
   * 
   * @returns {Promise<{command: string, error?: string}>}
   */
  async getLoginCommand() {
    throw new Error('getLoginCommand() must be implemented by subclass');
  }
  
  /**
   * Get full image URI for a given image name and tag
   * 
   * @param {string} imageName - Image name (e.g., 'factiii')
   * @param {string} tag - Image tag (e.g., 'latest', 'v1.0.0')
   * @returns {string} Full image URI
   */
  getImageUri(imageName, tag = 'latest') {
    throw new Error('getImageUri() must be implemented by subclass');
  }
  
  /**
   * Check if repository exists, create if needed
   * 
   * @param {string} repositoryName - Repository name
   * @returns {Promise<{exists: boolean, created?: boolean, error?: string}>}
   */
  async ensureRepository(repositoryName) {
    throw new Error('ensureRepository() must be implemented by subclass');
  }
  
  // ============================================================
  // OPTIONAL METHODS - Can be overridden by subclasses
  // ============================================================
  
  /**
   * List available tags for an image
   * 
   * @param {string} repositoryName - Repository name
   * @returns {Promise<{tags: string[], error?: string}>}
   */
  async listTags(repositoryName) {
    return { tags: [], error: 'listTags() not implemented' };
  }
  
  /**
   * Delete an image by tag
   * 
   * @param {string} repositoryName - Repository name
   * @param {string} tag - Tag to delete
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async deleteImage(repositoryName, tag) {
    return { success: false, error: 'deleteImage() not implemented' };
  }
  
  /**
   * Get registry URL
   * 
   * @returns {string} Registry URL (e.g., '123456789.dkr.ecr.us-east-1.amazonaws.com')
   */
  getRegistryUrl() {
    throw new Error('getRegistryUrl() must be implemented by subclass');
  }
  
  /**
   * Validate registry access
   * 
   * @returns {Promise<{valid: boolean, error?: string}>}
   */
  async validate() {
    try {
      const loginResult = await this.getLoginCommand();
      return { valid: !loginResult.error, error: loginResult.error };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }
}

module.exports = RegistryProvider;

