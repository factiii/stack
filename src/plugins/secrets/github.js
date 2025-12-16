/**
 * GitHub Secrets Plugin
 * 
 * Stores secrets in GitHub Actions Secrets for use in workflows.
 */
const { Octokit } = require('@octokit/rest');
const SecretStore = require('../interfaces/secret-store');

class GitHubSecretsStore extends SecretStore {
  // ============================================================
  // STATIC METADATA
  // ============================================================
  
  static id = 'github';
  static name = 'GitHub Secrets';
  static category = 'secrets';
  static version = '1.0.0';
  
  static capabilities = {
    canList: true,
    canCheck: true,
    canWrite: true,
    canDelete: true,
    canRead: false,  // GitHub doesn't allow reading secret values
    versioned: false
  };
  
  // ============================================================
  // CONSTRUCTOR
  // ============================================================
  
  /**
   * @param {Object} config - Plugin configuration
   * @param {string} config.token - GitHub token (or GITHUB_TOKEN env var)
   * @param {string} config.owner - Repository owner
   * @param {string} config.repo - Repository name
   */
  constructor(config = {}) {
    super(config);
    
    this.token = config.token || process.env.GITHUB_TOKEN;
    this.owner = config.owner;
    this.repo = config.repo;
    
    // Auto-detect repo info if not provided
    if (!this.owner || !this.repo) {
      const repoInfo = GitHubSecretsStore.getRepoInfo();
      if (repoInfo) {
        this.owner = this.owner || repoInfo.owner;
        this.repo = this.repo || repoInfo.repo;
      }
    }
    
    this.octokit = this.token ? new Octokit({ auth: this.token }) : null;
  }
  
  // ============================================================
  // STATIC HELPERS
  // ============================================================
  
  /**
   * Get GitHub repository info from git remote
   * @returns {{owner: string, repo: string} | null}
   */
  static getRepoInfo() {
    const { execSync } = require('child_process');
    
    try {
      const repoUrl = execSync('git config --get remote.origin.url', { 
        encoding: 'utf8',
        stdio: 'pipe'
      }).trim();
      
      const match = repoUrl.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/);
      if (match) {
        return {
          owner: match[1],
          repo: match[2]
        };
      }
    } catch (e) {
      // Ignore errors
    }
    
    return null;
  }
  
  /**
   * Encrypt a secret value for GitHub using libsodium
   * @param {string} value - Secret value to encrypt
   * @param {string} publicKey - Repository public key (base64)
   * @returns {Promise<string>} - Encrypted secret (base64)
   */
  static async encryptValue(value, publicKey) {
    const sodium = require('libsodium-wrappers');
    await sodium.ready;
    
    const publicKeyBytes = Buffer.from(publicKey, 'base64');
    const messageBytes = Buffer.from(value, 'utf8');
    const encryptedBytes = sodium.crypto_box_seal(messageBytes, publicKeyBytes);
    
    return Buffer.from(encryptedBytes).toString('base64');
  }
  
  // ============================================================
  // REQUIRED METHODS
  // ============================================================
  
  /**
   * Check which secrets exist in GitHub
   * 
   * @param {Array<{name: string}>} secrets - List of secret names to check
   * @returns {Promise<{present: string[], missing: string[], error?: string}>}
   */
  async checkSecrets(secrets) {
    const result = {
      present: [],
      missing: [],
      error: null
    };
    
    if (!this.octokit) {
      result.error = 'No GitHub token provided';
      return result;
    }
    
    if (!this.owner || !this.repo) {
      result.error = 'Could not determine repository owner/name';
      return result;
    }
    
    try {
      // Get list of all secrets in the repository
      const { data } = await this.octokit.rest.actions.listRepoSecrets({
        owner: this.owner,
        repo: this.repo,
        per_page: 100
      });
      
      const existingSecretNames = data.secrets.map(s => s.name);
      const secretNames = secrets.map(s => typeof s === 'string' ? s : s.name);
      
      for (const secretName of secretNames) {
        if (existingSecretNames.includes(secretName)) {
          result.present.push(secretName);
        } else {
          result.missing.push(secretName);
        }
      }
      
    } catch (error) {
      result.error = this._formatError(error);
    }
    
    return result;
  }
  
  /**
   * Upload/create a secret in GitHub
   * 
   * @param {string} name - Secret name
   * @param {string} value - Secret value
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async uploadSecret(name, value) {
    const result = {
      success: false,
      error: null
    };
    
    if (!this.octokit) {
      result.error = 'No GitHub token provided';
      return result;
    }
    
    if (!this.owner || !this.repo) {
      result.error = 'Could not determine repository owner/name';
      return result;
    }
    
    try {
      // Get repository public key
      const { data: publicKeyData } = await this.octokit.rest.actions.getRepoPublicKey({
        owner: this.owner,
        repo: this.repo
      });
      
      // Encrypt the secret
      const encryptedValue = await GitHubSecretsStore.encryptValue(
        value,
        publicKeyData.key
      );
      
      // Upload the secret
      await this.octokit.rest.actions.createOrUpdateRepoSecret({
        owner: this.owner,
        repo: this.repo,
        secret_name: name,
        encrypted_value: encryptedValue,
        key_id: publicKeyData.key_id
      });
      
      result.success = true;
    } catch (error) {
      result.error = this._formatError(error);
    }
    
    return result;
  }
  
  // ============================================================
  // OPTIONAL METHODS
  // ============================================================
  
  /**
   * List all secrets in GitHub (names only)
   * 
   * @returns {Promise<{secrets: string[], error?: string}>}
   */
  async listSecrets() {
    if (!this.octokit) {
      return { secrets: [], error: 'No GitHub token provided' };
    }
    
    try {
      const { data } = await this.octokit.rest.actions.listRepoSecrets({
        owner: this.owner,
        repo: this.repo,
        per_page: 100
      });
      
      return { secrets: data.secrets.map(s => s.name) };
    } catch (error) {
      return { secrets: [], error: this._formatError(error) };
    }
  }
  
  /**
   * Delete a secret from GitHub
   * 
   * @param {string} name - Secret name
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async deleteSecret(name) {
    if (!this.octokit) {
      return { success: false, error: 'No GitHub token provided' };
    }
    
    try {
      await this.octokit.rest.actions.deleteRepoSecret({
        owner: this.owner,
        repo: this.repo,
        secret_name: name
      });
      
      return { success: true };
    } catch (error) {
      return { success: false, error: this._formatError(error) };
    }
  }
  
  /**
   * Validate GitHub access
   * 
   * @returns {Promise<{valid: boolean, error?: string}>}
   */
  async validate() {
    if (!this.octokit) {
      return { valid: false, error: 'No GitHub token provided' };
    }
    
    if (!this.owner || !this.repo) {
      return { valid: false, error: 'Could not determine repository owner/name' };
    }
    
    try {
      // Try to get the repo to verify access
      await this.octokit.rest.repos.get({
        owner: this.owner,
        repo: this.repo
      });
      
      return { valid: true };
    } catch (error) {
      return { valid: false, error: this._formatError(error) };
    }
  }
  
  /**
   * Get the public key for encryption
   * 
   * @returns {Promise<{key?: string, keyId?: string, error?: string}>}
   */
  async getPublicKey() {
    if (!this.octokit) {
      return { error: 'No GitHub token provided' };
    }
    
    try {
      const { data } = await this.octokit.rest.actions.getRepoPublicKey({
        owner: this.owner,
        repo: this.repo
      });
      
      return { key: data.key, keyId: data.key_id };
    } catch (error) {
      return { error: this._formatError(error) };
    }
  }
  
  // ============================================================
  // PRIVATE HELPERS
  // ============================================================
  
  /**
   * Format API error message
   * @private
   */
  _formatError(error) {
    if (error.status === 401) {
      return 'GitHub token is invalid or expired';
    } else if (error.status === 403) {
      return 'GitHub token does not have permission to access secrets';
    } else if (error.status === 404) {
      return 'Repository not found or token lacks access';
    } else {
      return `GitHub API error: ${error.message}`;
    }
  }
}

module.exports = { GitHubSecretsStore };
