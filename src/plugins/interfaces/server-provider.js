/**
 * Base class for Server Provider plugins
 * 
 * Server providers handle deployment to different server types:
 * - Mac Mini (local/Tailscale)
 * - AWS EC2
 * - DigitalOcean Droplets
 * - etc.
 */
class ServerProvider {
  // ============================================================
  // STATIC METADATA - Override in subclasses
  // ============================================================
  
  /** Unique plugin identifier (e.g., 'mac-mini', 'aws-ec2') */
  static id = 'base-server';
  
  /** Human-readable name (e.g., 'Mac Mini', 'AWS EC2') */
  static name = 'Base Server Provider';
  
  /** Plugin category - always 'server' for server providers */
  static category = 'server';
  
  /** Plugin version */
  static version = '1.0.0';
  
  /**
   * Required secrets this plugin needs
   * @type {Array<{name: string, type: string, env?: string, description?: string, default?: string, autoGenerate?: boolean, autoDetect?: boolean}>}
   * 
   * Example:
   * [
   *   { name: 'SSH_KEY', type: 'ssh_key', env: 'STAGING_SSH', description: 'SSH private key' },
   *   { name: 'HOST', type: 'hostname', env: 'STAGING_HOST', description: 'Server hostname' },
   *   { name: 'USER', type: 'username', env: 'STAGING_USER', default: 'ubuntu' }
   * ]
   */
  static requiredSecrets = [];
  
  /**
   * Help text for each secret (shown during prompts)
   * @type {Object<string, string>}
   */
  static helpText = {};
  
  /**
   * Plugin capabilities
   * @type {{autoProvision?: boolean, autoSSHKey?: boolean, elasticIP?: boolean, autoScaling?: boolean}}
   */
  static capabilities = {
    autoProvision: false,
    autoSSHKey: false,
    elasticIP: false,
    autoScaling: false
  };
  
  // ============================================================
  // CONSTRUCTOR
  // ============================================================
  
  /**
   * @param {Object} config - Plugin configuration from factiii.yml
   * @param {Object} secrets - Resolved secrets (values, not secret names)
   */
  constructor(config = {}, secrets = {}) {
    this.config = config;
    this.secrets = secrets;
  }
  
  // ============================================================
  // REQUIRED METHODS - Must be implemented by subclasses
  // ============================================================
  
  /**
   * Initial server setup
   * - Verify prerequisites (Docker, etc.)
   * - Create infrastructure directory
   * - Set up networking
   * 
   * @param {Object} envConfig - Environment configuration from factiii.yml
   * @returns {Promise<{success: boolean, message?: string, error?: string}>}
   */
  async setup(envConfig) {
    throw new Error('setup() must be implemented by subclass');
  }
  
  /**
   * Deploy a container to the server
   * - Pull image from registry
   * - Stop existing container
   * - Start new container
   * - Run health checks
   * 
   * @param {string} image - Full image URI (e.g., 123456789.dkr.ecr.us-east-1.amazonaws.com/app:latest)
   * @param {Object} envConfig - Environment configuration
   * @returns {Promise<{success: boolean, containerId?: string, message?: string, error?: string}>}
   */
  async deploy(image, envConfig) {
    throw new Error('deploy() must be implemented by subclass');
  }
  
  /**
   * Check if server is reachable and healthy
   * 
   * @param {Object} envConfig - Environment configuration
   * @returns {Promise<{healthy: boolean, details?: Object, error?: string}>}
   */
  async healthCheck(envConfig) {
    throw new Error('healthCheck() must be implemented by subclass');
  }
  
  /**
   * Get current deployment status
   * 
   * @param {Object} envConfig - Environment configuration
   * @returns {Promise<{deployed: boolean, container?: Object, uptime?: string, error?: string}>}
   */
  async getStatus(envConfig) {
    throw new Error('getStatus() must be implemented by subclass');
  }
  
  /**
   * Remove deployment from server
   * - Stop and remove container
   * - Clean up config files
   * - Regenerate nginx (if applicable)
   * 
   * @param {Object} envConfig - Environment configuration
   * @returns {Promise<{success: boolean, message?: string, error?: string}>}
   */
  async teardown(envConfig) {
    throw new Error('teardown() must be implemented by subclass');
  }
  
  // ============================================================
  // OPTIONAL METHODS - Can be overridden by subclasses
  // ============================================================
  
  /**
   * Test SSH connection to server
   * 
   * @returns {Promise<{success: boolean, message?: string, error?: string}>}
   */
  async testConnection() {
    // Default implementation using SSH
    const { execSync } = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    
    const sshKey = this.secrets.SSH_KEY || this.secrets.ssh_key;
    const host = this.secrets.HOST || this.secrets.host;
    const user = this.secrets.USER || this.secrets.user || 'ubuntu';
    
    if (!sshKey || !host) {
      return { success: false, error: 'Missing SSH_KEY or HOST' };
    }
    
    // Write SSH key to temp file
    const tempKeyPath = path.join(os.tmpdir(), `core_ssh_${Date.now()}`);
    
    try {
      fs.writeFileSync(tempKeyPath, sshKey, { mode: 0o600 });
      
      execSync(
        `ssh -i ${tempKeyPath} -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${user}@${host} "echo connected"`,
        { encoding: 'utf8', stdio: 'pipe' }
      );
      
      return { success: true, message: `Connected to ${user}@${host}` };
    } catch (error) {
      return { success: false, error: error.message };
    } finally {
      try {
        if (fs.existsSync(tempKeyPath)) {
          fs.unlinkSync(tempKeyPath);
        }
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }
  
  /**
   * Execute command on server via SSH
   * 
   * @param {string} command - Command to execute
   * @returns {Promise<{success: boolean, output?: string, error?: string}>}
   */
  async executeCommand(command) {
    const { execSync } = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    
    const sshKey = this.secrets.SSH_KEY || this.secrets.ssh_key;
    const host = this.secrets.HOST || this.secrets.host;
    const user = this.secrets.USER || this.secrets.user || 'ubuntu';
    
    if (!sshKey || !host) {
      return { success: false, error: 'Missing SSH_KEY or HOST' };
    }
    
    const tempKeyPath = path.join(os.tmpdir(), `core_ssh_${Date.now()}`);
    
    try {
      fs.writeFileSync(tempKeyPath, sshKey, { mode: 0o600 });
      
      const output = execSync(
        `ssh -i ${tempKeyPath} -o StrictHostKeyChecking=no ${user}@${host} "${command.replace(/"/g, '\\"')}"`,
        { encoding: 'utf8', stdio: 'pipe' }
      );
      
      return { success: true, output: output.trim() };
    } catch (error) {
      return { success: false, error: error.message };
    } finally {
      try {
        if (fs.existsSync(tempKeyPath)) {
          fs.unlinkSync(tempKeyPath);
        }
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }
  
  /**
   * Get prefixed secret names for an environment
   * 
   * @param {string} envName - Environment name (e.g., 'staging', 'production')
   * @returns {Array<{name: string, envVar: string, type: string, description?: string, default?: string}>}
   */
  static getSecretsForEnvironment(envName) {
    const prefix = envName.toUpperCase();
    return this.requiredSecrets.map(secret => ({
      ...secret,
      envVar: secret.env || `${prefix}_${secret.name}`,
      fullName: `${prefix}_${secret.name}`
    }));
  }
}

module.exports = ServerProvider;

