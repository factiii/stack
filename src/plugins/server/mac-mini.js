/**
 * Mac Mini Server Provider Plugin
 * 
 * Deploys containers to a Mac Mini server via SSH.
 * Typically used for staging environments (local network or Tailscale).
 */
const ServerProvider = require('../interfaces/server-provider');

class MacMiniProvider extends ServerProvider {
  // ============================================================
  // STATIC METADATA
  // ============================================================
  
  static id = 'mac-mini';
  static name = 'Mac Mini';
  static category = 'server';
  static version = '1.0.0';
  
  static requiredSecrets = [
    { 
      name: 'SSH_KEY', 
      type: 'ssh_key', 
      description: 'SSH private key for accessing Mac Mini'
    },
    { 
      name: 'HOST', 
      type: 'hostname', 
      description: 'Mac Mini hostname or IP address'
    },
    { 
      name: 'USER', 
      type: 'username', 
      description: 'macOS username with SSH access',
      default: 'admin'
    }
  ];
  
  static helpText = {
    SSH_KEY: `
   For Mac Mini, use your existing SSH key or generate new:
   
   Step 1: Generate a new SSH key pair:
   ssh-keygen -t ed25519 -C "mac-mini-deploy" -f ~/.ssh/mac_mini_deploy
   
   Step 2: Enable Remote Login on Mac Mini:
   System Preferences → Sharing → Remote Login → On
   
   Step 3: Add PUBLIC key to Mac Mini (replace YOUR_USER and YOUR_HOST):
   ssh-copy-id -i ~/.ssh/mac_mini_deploy.pub YOUR_USER@YOUR_HOST
   
   Or manually:
   cat ~/.ssh/mac_mini_deploy.pub | ssh YOUR_USER@YOUR_HOST "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
   
   Step 4: Paste the PRIVATE key below (multi-line, end with blank line):
   cat ~/.ssh/mac_mini_deploy`,
    
    HOST: `
   Mac Mini IP address or hostname
   
   Examples:
   - Local network: 192.168.1.100
   - Tailscale: mac-mini.tail12345.ts.net
   - mDNS: mac-mini.local
   
   Enter Mac Mini hostname or IP:`,
    
    USER: `
   macOS username with SSH access
   
   Common usernames: admin, deploy, your-username
   
   Enter SSH username (default: admin):`
  };
  
  static capabilities = {
    autoProvision: false,  // Can't auto-create Mac Minis
    autoSSHKey: false,     // Requires manual key setup
    elasticIP: false,      // N/A
    autoScaling: false     // N/A
  };
  
  // ============================================================
  // REQUIRED METHODS
  // ============================================================
  
  /**
   * Initial server setup
   */
  async setup(envConfig) {
    const result = { success: false, message: '', error: null };
    
    // Test SSH connection
    const connTest = await this.testConnection();
    if (!connTest.success) {
      result.error = `SSH connection failed: ${connTest.error}`;
      return result;
    }
    
    // Check/install prerequisites
    const prereqs = await this._checkPrerequisites();
    if (!prereqs.success) {
      result.error = prereqs.error;
      return result;
    }
    
    // Create infrastructure directory
    const infraDir = await this._setupInfrastructureDir();
    if (!infraDir.success) {
      result.error = infraDir.error;
      return result;
    }
    
    result.success = true;
    result.message = 'Mac Mini setup complete';
    return result;
  }
  
  /**
   * Deploy a container to the Mac Mini
   */
  async deploy(image, envConfig) {
    const result = { 
      success: false, 
      containerId: null, 
      message: '', 
      error: null 
    };
    
    const serviceName = `${envConfig.name || 'app'}-${envConfig.environment || 'staging'}`;
    const port = envConfig.port || 3000;
    
    try {
      // Login to ECR (if using ECR)
      if (image.includes('.ecr.')) {
        const ecrLogin = await this._ecrLogin(image);
        if (!ecrLogin.success) {
          result.error = `ECR login failed: ${ecrLogin.error}`;
          return result;
        }
      }
      
      // Pull the image
      const pullResult = await this.executeCommand(`docker pull ${image}`);
      if (!pullResult.success) {
        result.error = `Failed to pull image: ${pullResult.error}`;
        return result;
      }
      
      // Stop existing container if running
      await this.executeCommand(`docker stop ${serviceName} 2>/dev/null || true`);
      await this.executeCommand(`docker rm ${serviceName} 2>/dev/null || true`);
      
      // Start new container
      const envFile = envConfig.envFile || `~/infrastructure/envs/${serviceName}.env`;
      const runCommand = [
        'docker run -d',
        `--name ${serviceName}`,
        `-p ${port}:${port}`,
        `--env-file ${envFile}`,
        '--restart unless-stopped',
        image
      ].join(' ');
      
      const runResult = await this.executeCommand(runCommand);
      if (!runResult.success) {
        result.error = `Failed to start container: ${runResult.error}`;
        return result;
      }
      
      result.containerId = runResult.output.trim();
      
      // Wait for container to be healthy
      const healthResult = await this._waitForHealth(serviceName, envConfig);
      if (!healthResult.healthy) {
        result.error = `Container started but health check failed: ${healthResult.error}`;
        // Don't return - container is running, just not healthy yet
      }
      
      result.success = true;
      result.message = `Deployed ${serviceName} on port ${port}`;
      
    } catch (error) {
      result.error = error.message;
    }
    
    return result;
  }
  
  /**
   * Check if server is reachable and healthy
   */
  async healthCheck(envConfig) {
    const result = { healthy: false, details: {}, error: null };
    
    // Test SSH connection
    const sshTest = await this.testConnection();
    result.details.ssh = sshTest.success;
    
    if (!sshTest.success) {
      result.error = sshTest.error;
      return result;
    }
    
    // Check Docker is running
    const dockerTest = await this.executeCommand('docker info > /dev/null 2>&1 && echo "running"');
    result.details.docker = dockerTest.success && dockerTest.output?.includes('running');
    
    if (!result.details.docker) {
      result.error = 'Docker is not running on Mac Mini';
      return result;
    }
    
    // Check container status if envConfig provided
    if (envConfig?.name) {
      const serviceName = `${envConfig.name}-${envConfig.environment || 'staging'}`;
      const containerCheck = await this.executeCommand(`docker inspect ${serviceName} --format '{{.State.Status}}'`);
      result.details.container = containerCheck.output?.trim();
      result.details.containerRunning = result.details.container === 'running';
    }
    
    result.healthy = result.details.docker && (result.details.containerRunning !== false);
    return result;
  }
  
  /**
   * Get current deployment status
   */
  async getStatus(envConfig) {
    const result = { 
      deployed: false, 
      container: null, 
      uptime: null, 
      error: null 
    };
    
    const serviceName = `${envConfig.name || 'app'}-${envConfig.environment || 'staging'}`;
    
    try {
      const inspectResult = await this.executeCommand(
        `docker inspect ${serviceName} --format '{{json .}}'`
      );
      
      if (!inspectResult.success) {
        return result; // Container doesn't exist
      }
      
      const containerInfo = JSON.parse(inspectResult.output);
      
      result.deployed = true;
      result.container = {
        id: containerInfo.Id?.substring(0, 12),
        name: containerInfo.Name?.replace(/^\//, ''),
        image: containerInfo.Config?.Image,
        status: containerInfo.State?.Status,
        running: containerInfo.State?.Running,
        startedAt: containerInfo.State?.StartedAt
      };
      
      // Calculate uptime
      if (containerInfo.State?.StartedAt) {
        const started = new Date(containerInfo.State.StartedAt);
        const now = new Date();
        const uptimeMs = now - started;
        const uptimeHours = Math.floor(uptimeMs / (1000 * 60 * 60));
        const uptimeMins = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
        result.uptime = `${uptimeHours}h ${uptimeMins}m`;
      }
      
    } catch (error) {
      result.error = error.message;
    }
    
    return result;
  }
  
  /**
   * Remove deployment from server
   */
  async teardown(envConfig) {
    const result = { success: false, message: '', error: null };
    
    const serviceName = `${envConfig.name || 'app'}-${envConfig.environment || 'staging'}`;
    
    try {
      // Stop container
      await this.executeCommand(`docker stop ${serviceName} 2>/dev/null || true`);
      
      // Remove container
      await this.executeCommand(`docker rm ${serviceName} 2>/dev/null || true`);
      
      // Remove config file
      await this.executeCommand(
        `rm -f ~/infrastructure/configs/${envConfig.name}.yml 2>/dev/null || true`
      );
      
      // Remove env file
      await this.executeCommand(
        `rm -f ~/infrastructure/envs/${serviceName}.env 2>/dev/null || true`
      );
      
      result.success = true;
      result.message = `Removed ${serviceName} from Mac Mini`;
      
    } catch (error) {
      result.error = error.message;
    }
    
    return result;
  }
  
  // ============================================================
  // PRIVATE HELPERS
  // ============================================================
  
  /**
   * Check prerequisites are installed
   * @private
   */
  async _checkPrerequisites() {
    const result = { success: false, missing: [], error: null };
    
    // Check Docker
    const dockerCheck = await this.executeCommand('which docker');
    if (!dockerCheck.success || !dockerCheck.output) {
      result.missing.push('docker');
    }
    
    // Check Docker is running
    const dockerRunning = await this.executeCommand('docker info > /dev/null 2>&1 && echo ok');
    if (!dockerRunning.success || !dockerRunning.output?.includes('ok')) {
      result.error = 'Docker is installed but not running. Start Docker Desktop on the Mac Mini.';
      return result;
    }
    
    if (result.missing.length > 0) {
      result.error = `Missing prerequisites: ${result.missing.join(', ')}. Install Docker Desktop on the Mac Mini.`;
      return result;
    }
    
    result.success = true;
    return result;
  }
  
  /**
   * Set up infrastructure directory
   * @private
   */
  async _setupInfrastructureDir() {
    const result = { success: false, error: null };
    
    const commands = [
      'mkdir -p ~/infrastructure/configs',
      'mkdir -p ~/infrastructure/envs',
      'mkdir -p ~/infrastructure/nginx'
    ];
    
    for (const cmd of commands) {
      const cmdResult = await this.executeCommand(cmd);
      if (!cmdResult.success) {
        result.error = `Failed to create directory: ${cmdResult.error}`;
        return result;
      }
    }
    
    result.success = true;
    return result;
  }
  
  /**
   * Login to ECR
   * @private
   */
  async _ecrLogin(image) {
    const result = { success: false, error: null };
    
    // Extract region from image URL
    const regionMatch = image.match(/\.ecr\.([^.]+)\.amazonaws\.com/);
    const region = regionMatch ? regionMatch[1] : 'us-east-1';
    
    // Get ECR login password and pipe to docker login
    const loginCommand = `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin $(echo "${image}" | cut -d/ -f1)`;
    
    const loginResult = await this.executeCommand(loginCommand);
    if (!loginResult.success) {
      result.error = loginResult.error;
      return result;
    }
    
    result.success = true;
    return result;
  }
  
  /**
   * Wait for container health check
   * @private
   */
  async _waitForHealth(serviceName, envConfig, maxWaitSeconds = 60) {
    const result = { healthy: false, error: null };
    const startTime = Date.now();
    const healthEndpoint = envConfig.healthCheck || '/health';
    const port = envConfig.port || 3000;
    
    while (Date.now() - startTime < maxWaitSeconds * 1000) {
      // Check if container is running
      const statusCheck = await this.executeCommand(
        `docker inspect ${serviceName} --format '{{.State.Status}}'`
      );
      
      if (statusCheck.output?.trim() !== 'running') {
        result.error = `Container status: ${statusCheck.output?.trim() || 'unknown'}`;
        return result;
      }
      
      // Try HTTP health check
      const healthCheck = await this.executeCommand(
        `curl -sf http://localhost:${port}${healthEndpoint} > /dev/null && echo "healthy"`
      );
      
      if (healthCheck.output?.includes('healthy')) {
        result.healthy = true;
        return result;
      }
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    result.error = `Health check timed out after ${maxWaitSeconds} seconds`;
    return result;
  }
}

module.exports = MacMiniProvider;

