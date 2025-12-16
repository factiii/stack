/**
 * Base class for Secret Store plugins
 * 
 * Secret stores handle storage and retrieval of secrets:
 * - GitHub Secrets (for GitHub Actions)
 * - AWS Secrets Manager
 * - HashiCorp Vault
 * - Local .env files (for development)
 */
class SecretStore {
  // ============================================================
  // STATIC METADATA - Override in subclasses
  // ============================================================
  
  /** Unique plugin identifier (e.g., 'github', 'aws-sm', 'vault') */
  static id = 'base-secret-store';
  
  /** Human-readable name */
  static name = 'Base Secret Store';
  
  /** Plugin category - always 'secrets' for secret stores */
  static category = 'secrets';
  
  /** Plugin version */
  static version = '1.0.0';
  
  /**
   * Capabilities of this secret store
   */
  static capabilities = {
    /** Can list existing secrets (names only, not values) */
    canList: false,
    /** Can check if a secret exists */
    canCheck: false,
    /** Can create/update secrets */
    canWrite: false,
    /** Can delete secrets */
    canDelete: false,
    /** Can read secret values (security risk, use carefully) */
    canRead: false,
    /** Supports versioning */
    versioned: false
  };
  
  // ============================================================
  // CONSTRUCTOR
  // ============================================================
  
  /**
   * @param {Object} config - Plugin configuration
   * @param {string} config.token - Authentication token (e.g., GITHUB_TOKEN)
   * @param {string} config.owner - Repository owner (for GitHub)
   * @param {string} config.repo - Repository name (for GitHub)
   */
  constructor(config = {}) {
    this.config = config;
  }
  
  // ============================================================
  // REQUIRED METHODS - Must be implemented by subclasses
  // ============================================================
  
  /**
   * Check which secrets exist in the store
   * 
   * @param {Array<{name: string}>} secrets - List of secret names to check
   * @returns {Promise<{present: string[], missing: string[], error?: string}>}
   */
  async checkSecrets(secrets) {
    throw new Error('checkSecrets() must be implemented by subclass');
  }
  
  /**
   * Upload/create a secret
   * 
   * @param {string} name - Secret name
   * @param {string} value - Secret value
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async uploadSecret(name, value) {
    throw new Error('uploadSecret() must be implemented by subclass');
  }
  
  // ============================================================
  // OPTIONAL METHODS - Can be overridden by subclasses
  // ============================================================
  
  /**
   * List all secrets in the store (names only)
   * 
   * @returns {Promise<{secrets: string[], error?: string}>}
   */
  async listSecrets() {
    return { secrets: [], error: 'listSecrets() not implemented' };
  }
  
  /**
   * Delete a secret
   * 
   * @param {string} name - Secret name
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async deleteSecret(name) {
    return { success: false, error: 'deleteSecret() not implemented' };
  }
  
  /**
   * Read a secret value (use with caution)
   * Most secret stores don't allow reading values back
   * 
   * @param {string} name - Secret name
   * @returns {Promise<{value?: string, error?: string}>}
   */
  async readSecret(name) {
    return { error: 'readSecret() not implemented or not supported' };
  }
  
  /**
   * Validate that the store is accessible
   * 
   * @returns {Promise<{valid: boolean, error?: string}>}
   */
  async validate() {
    return { valid: false, error: 'validate() not implemented' };
  }
  
  /**
   * Get the public key for encryption (if applicable)
   * GitHub Secrets requires encrypting with repo's public key
   * 
   * @returns {Promise<{key?: string, keyId?: string, error?: string}>}
   */
  async getPublicKey() {
    return { error: 'getPublicKey() not implemented or not needed' };
  }
}

module.exports = SecretStore;

