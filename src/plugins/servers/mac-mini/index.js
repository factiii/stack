/**
 * Mac Mini Server Plugin
 * 
 * Deploys containers to a Mac Mini server via SSH.
 * Typically used for staging environments (local network or Tailscale).
 * Supports dev stage for local Docker development.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

class MacMiniPlugin {
  // ============================================================
  // STATIC METADATA
  // ============================================================
  
  static id = 'mac-mini';
  static name = 'Mac Mini Server';
  static category = 'server';
  static version = '1.0.0';
  
  // Env vars this plugin requires
  static requiredEnvVars = [];
  
  // Schema for factiii.yml (user-editable)
  static configSchema = {
    // No user config needed - uses environments.staging.host
  };
  
  // Schema for factiiiAuto.yml (auto-detected)
  static autoConfigSchema = {
    ssh_user: 'string'
  };
  
  static helpText = {
    SSH: `
   SSH private key for accessing the server.
   
   Step 1: Generate a new SSH key pair (if needed):
   ssh-keygen -t ed25519 -C "deploy-key" -f ~/.ssh/deploy_key
   
   Step 2: Add PUBLIC key to server:
   ssh-copy-id -i ~/.ssh/deploy_key.pub ubuntu@YOUR_HOST
   
   Step 3: Paste the PRIVATE key below (multi-line, end with blank line):
   cat ~/.ssh/deploy_key`
  };
  
  // ============================================================
  // FIXES - All issues this plugin can detect and resolve
  // ============================================================
  
  static fixes = [
    // DEV STAGE FIXES - Local development
    {
      id: 'docker-not-installed-dev',
      stage: 'dev',
      severity: 'critical',
      description: 'Docker is not installed locally',
      scan: async (config, rootDir) => {
        try {
          execSync('which docker', { stdio: 'pipe' });
          return false; // No problem
        } catch {
          return true; // Problem exists
        }
      },
      fix: null,
      manualFix: 'Install Docker Desktop: https://www.docker.com/products/docker-desktop/'
    },
    {
      id: 'docker-not-running-dev',
      stage: 'dev',
      severity: 'critical',
      description: 'Docker is not running locally',
      scan: async (config, rootDir) => {
        try {
          execSync('docker info', { stdio: 'pipe' });
          return false; // No problem
        } catch {
          return true; // Problem exists
        }
      },
      fix: null,
      manualFix: 'Start Docker Desktop or run: open -a Docker'
    },
    {
      id: 'missing-dockerfile-dev',
      stage: 'dev',
      severity: 'warning',
      description: 'Dockerfile not found',
      scan: async (config, rootDir) => {
        const commonPaths = [
          'Dockerfile',
          'apps/server/Dockerfile',
          'packages/server/Dockerfile'
        ];
        for (const p of commonPaths) {
          if (fs.existsSync(path.join(rootDir, p))) return false;
        }
        return true;
      },
      fix: null,
      manualFix: 'Create a Dockerfile for your application'
    },
    {
      id: 'missing-docker-compose-dev',
      stage: 'dev',
      severity: 'info',
      description: 'docker-compose.yml not found (optional for dev)',
      scan: async (config, rootDir) => {
        return !fs.existsSync(path.join(rootDir, 'docker-compose.yml')) &&
               !fs.existsSync(path.join(rootDir, 'compose.yml'));
      },
      fix: null,
      manualFix: 'Create docker-compose.yml for local development (optional)'
    },
    
    // STAGING STAGE FIXES
    {
      id: 'staging-host-missing',
      stage: 'staging',
      severity: 'critical',
      description: 'Staging host not configured in factiii.yml',
      scan: async (config, rootDir) => {
        return !config?.environments?.staging?.host;
      },
      fix: null,
      manualFix: 'Add environments.staging.host to factiii.yml'
    },
    {
      id: 'staging-unreachable',
      stage: 'staging',
      severity: 'critical',
      description: 'Cannot reach staging server',
      scan: async (config, rootDir) => {
        const host = config?.environments?.staging?.host;
        if (!host) return false; // Will be caught by staging-host-missing
        
        try {
          // Try to ping the host
          execSync(`ping -c 1 -W 3 ${host}`, { stdio: 'pipe' });
          return false;
        } catch {
          return true;
        }
      },
      fix: null,
      manualFix: 'Check network connectivity to staging server'
    },
    {
      id: 'staging-docker-missing',
      stage: 'staging',
      severity: 'critical',
      description: 'Docker not installed on staging server',
      scan: async (config, rootDir) => {
        const host = config?.environments?.staging?.host;
        if (!host) return false;
        
        try {
          const result = await MacMiniPlugin.sshExec(config.environments.staging, 'which docker');
          return !result;
        } catch {
          return true;
        }
      },
      fix: async (config, rootDir) => {
        console.log('   Installing Docker on staging server...');
        try {
          await MacMiniPlugin.sshExec(
            config.environments.staging,
            'brew install --cask docker || (curl -fsSL https://get.docker.com | sh)'
          );
          return true;
        } catch (e) {
          console.log(`   Failed: ${e.message}`);
          return false;
        }
      },
      manualFix: 'SSH to server and install Docker: brew install --cask docker'
    }
  ];
  
  // ============================================================
  // STATIC HELPER METHODS
  // ============================================================
  
  /**
   * Auto-detect Mac Mini configuration
   */
  static async detectConfig(rootDir) {
    return {
      ssh_user: 'ubuntu'  // Default SSH user
    };
  }
  
  /**
   * Execute a command on a remote server via SSH
   */
  static async sshExec(envConfig, command) {
    const host = envConfig.host;
    const user = envConfig.ssh_user || 'ubuntu';
    
    // Try to find SSH key
    const keyPaths = [
      path.join(os.homedir(), '.ssh', 'id_ed25519'),
      path.join(os.homedir(), '.ssh', 'id_rsa')
    ];
    
    let keyPath = null;
    for (const kp of keyPaths) {
      if (fs.existsSync(kp)) {
        keyPath = kp;
        break;
      }
    }
    
    if (!keyPath) {
      throw new Error('No SSH key found');
    }
    
    const result = execSync(
      `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${user}@${host} "${command.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8', stdio: 'pipe' }
    );
    
    return result.trim();
  }
  
  // ============================================================
  // INSTANCE METHODS
  // ============================================================
  
  constructor(config = {}) {
    this.config = config;
  }
  
  /**
   * Deploy to an environment
   */
  async deploy(config, environment) {
    if (environment === 'dev') {
      return this.deployDev(config);
    } else if (environment === 'staging') {
      return this.deployStaging(config);
    }
    
    return { success: false, error: `Unsupported environment: ${environment}` };
  }
  
  /**
   * Deploy to local dev environment
   */
  async deployDev(config) {
    console.log('   🐳 Starting local dev containers...');
    
    try {
      // Check for docker-compose file
      const composeFile = fs.existsSync('docker-compose.yml') ? 'docker-compose.yml' :
                         fs.existsSync('compose.yml') ? 'compose.yml' : null;
      
      if (composeFile) {
        execSync(`docker compose -f ${composeFile} up -d`, { stdio: 'inherit' });
        return { success: true, message: 'Local containers started' };
      } else {
        console.log('   No docker-compose.yml found, skipping container start');
        return { success: true, message: 'No compose file, skipped' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Deploy to staging server
   */
  async deployStaging(config) {
    const envConfig = config.environments?.staging;
    if (!envConfig?.host) {
      return { success: false, error: 'Staging host not configured' };
    }
    
    console.log(`   🔨 Building and deploying on staging (${envConfig.host})...`);
    
    try {
      const repoName = config.name || 'app';
      
      await MacMiniPlugin.sshExec(envConfig, `
        cd ~/.factiii/${repoName} && \
        docker compose build ${repoName}-staging && \
        docker compose up -d ${repoName}-staging
      `);
      
      return { success: true, message: 'Staging deployment complete' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Undeploy from an environment
   */
  async undeploy(config, environment) {
    if (environment === 'dev') {
      try {
        execSync('docker compose down', { stdio: 'inherit' });
        return { success: true, message: 'Local containers stopped' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    } else if (environment === 'staging') {
      const envConfig = config.environments?.staging;
      if (!envConfig?.host) {
        return { success: false, error: 'Staging host not configured' };
      }
      
      try {
        const repoName = config.name || 'app';
        await MacMiniPlugin.sshExec(envConfig, `
          cd ~/.factiii && docker compose stop ${repoName}-staging
        `);
        return { success: true, message: 'Staging containers stopped' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    
    return { success: false, error: `Unsupported environment: ${environment}` };
  }
}

module.exports = MacMiniPlugin;
