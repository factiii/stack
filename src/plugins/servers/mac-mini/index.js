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
  
  /**
   * Determine if this plugin should be loaded for this project
   * Loads if config has staging host with local/private IP, or on init (no config)
   */
  static async shouldLoad(rootDir, config = {}) {
    // If config exists with staging host, check if it's local/private IP
    const stagingHost = config?.environments?.staging?.host;
    if (stagingHost && !stagingHost.startsWith('EXAMPLE-')) {
      // Check if it's a local/private IP (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
      return /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(stagingHost);
    }
    
    // On init (no config or EXAMPLE values), load as default staging option
    return Object.keys(config).length === 0 || !config.environments;
  }
  
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
        // Only check if staging environment is defined in config
        const hasStagingEnv = config?.environments?.staging;
        if (!hasStagingEnv) return false; // Skip check if staging not configured
        
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
        // Only check if staging environment is defined in config
        const hasStagingEnv = config?.environments?.staging;
        if (!hasStagingEnv) return false; // Skip check if staging not configured
        
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
        // Only check if staging environment is defined in config
        const hasStagingEnv = config?.environments?.staging;
        if (!hasStagingEnv) return false; // Skip check if staging not configured
        
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
    },
    {
      id: 'staging-node-missing',
      stage: 'staging',
      severity: 'critical',
      description: 'Node.js not installed on staging server',
      scan: async (config, rootDir) => {
        const hasStagingEnv = config?.environments?.staging;
        if (!hasStagingEnv) return false;
        
        const host = config?.environments?.staging?.host;
        if (!host) return false;
        
        try {
          const result = await MacMiniPlugin.sshExec(config.environments.staging, 'which node');
          return !result;
        } catch {
          return true;
        }
      },
      fix: async (config, rootDir) => {
        console.log('   Installing Node.js on staging server...');
        try {
          // Try Homebrew first (Mac), then fall back to NodeSource (Linux)
          await MacMiniPlugin.sshExec(
            config.environments.staging,
            'brew install node || (curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs)'
          );
          return true;
        } catch (e) {
          console.log(`   Failed: ${e.message}`);
          return false;
        }
      },
      manualFix: 'SSH to server and install Node.js: brew install node (Mac) or use NodeSource (Linux)'
    },
    {
      id: 'staging-git-missing',
      stage: 'staging',
      severity: 'critical',
      description: 'Git not installed on staging server',
      scan: async (config, rootDir) => {
        const hasStagingEnv = config?.environments?.staging;
        if (!hasStagingEnv) return false;
        
        const host = config?.environments?.staging?.host;
        if (!host) return false;
        
        try {
          const result = await MacMiniPlugin.sshExec(config.environments.staging, 'which git');
          return !result;
        } catch {
          return true;
        }
      },
      fix: async (config, rootDir) => {
        console.log('   Installing git on staging server...');
        try {
          await MacMiniPlugin.sshExec(
            config.environments.staging,
            'brew install git || sudo apt-get install -y git'
          );
          return true;
        } catch (e) {
          console.log(`   Failed: ${e.message}`);
          return false;
        }
      },
      manualFix: 'SSH to server and install git: brew install git (Mac) or sudo apt-get install git (Linux)'
    },
    {
      id: 'staging-pnpm-missing',
      stage: 'staging',
      severity: 'warning',
      description: 'pnpm not installed on staging server',
      scan: async (config, rootDir) => {
        // Only check if staging environment is defined in config
        const hasStagingEnv = config?.environments?.staging;
        if (!hasStagingEnv) return false;
        
        // Only check if project uses pnpm
        const autoConfigPath = path.join(rootDir, 'factiiiAuto.yml');
        if (!fs.existsSync(autoConfigPath)) return false;
        
        try {
          const yaml = require('js-yaml');
          const autoConfig = yaml.load(fs.readFileSync(autoConfigPath, 'utf8'));
          if (autoConfig?.package_manager !== 'pnpm') return false;
        } catch {
          return false;
        }
        
        const host = config?.environments?.staging?.host;
        if (!host) return false;
        
        try {
          const result = await MacMiniPlugin.sshExec(
            config.environments.staging, 
            'which pnpm'
          );
          return !result;
        } catch {
          return true;
        }
      },
      fix: async (config, rootDir) => {
        console.log('   Installing pnpm on staging server...');
        try {
          await MacMiniPlugin.sshExec(
            config.environments.staging,
            'npm install -g pnpm@9'
          );
          return true;
        } catch (e) {
          console.log(`   Failed: ${e.message}`);
          return false;
        }
      },
      manualFix: 'SSH to server and run: npm install -g pnpm@9'
    },
    {
      id: 'staging-repo-not-cloned',
      stage: 'staging',
      severity: 'warning',
      description: 'Repository not cloned on staging server',
      scan: async (config, rootDir) => {
        const hasStagingEnv = config?.environments?.staging;
        if (!hasStagingEnv) return false;
        
        const host = config?.environments?.staging?.host;
        if (!host) return false;
        
        const repoName = config.name || 'app';
        
        try {
          const result = await MacMiniPlugin.sshExec(
            config.environments.staging,
            `test -d ~/.factiii/${repoName}/.git && echo "exists" || echo "missing"`
          );
          return result.includes('missing');
        } catch {
          return true;
        }
      },
      fix: null, // Will be handled by ensureServerReady()
      manualFix: 'Repository will be cloned automatically on first deployment'
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
    const { sshExec } = require('../../utils/ssh-helper');
    return await sshExec(envConfig, command);
  }
  
  // ============================================================
  // INSTANCE METHODS
  // ============================================================
  
  constructor(config = {}) {
    this.config = config;
  }
  
  /**
   * Ensure server is ready for deployment
   * Installs Node.js, git, pnpm, clones repo, checks out commit
   */
  async ensureServerReady(config, environment, options = {}) {
    if (environment !== 'staging') {
      return { success: true, message: 'Mac Mini only handles staging' };
    }
    
    const envConfig = config.environments?.staging;
    if (!envConfig?.host) {
      throw new Error('Staging host not configured');
    }
    
    const { commitHash, branch = 'main', repoUrl } = options;
    const repoName = config.name || 'app';
    const repoDir = `~/.factiii/${repoName}`;
    
    try {
      // 1. Ensure Node.js is installed
      console.log('   Checking Node.js...');
      await this.ensureNodeInstalled(envConfig);
      
      // 2. Ensure git is installed
      console.log('   Checking git...');
      await this.ensureGitInstalled(envConfig);
      
      // 3. Ensure repo is cloned and up to date
      console.log('   Syncing repository...');
      await this.ensureRepoCloned(envConfig, repoUrl, repoDir, repoName);
      await this.pullAndCheckout(envConfig, repoDir, branch, commitHash);
      
      // 4. Ensure pnpm is installed
      console.log('   Checking pnpm...');
      await this.ensurePnpmInstalled(envConfig);
      
      // 5. Install dependencies
      console.log('   Installing dependencies...');
      await this.installDependencies(envConfig, repoDir);
      
      return { success: true, message: 'Server ready' };
    } catch (error) {
      throw new Error(`Failed to prepare server: ${error.message}`);
    }
  }
  
  /**
   * Ensure Node.js is installed on the server
   */
  async ensureNodeInstalled(envConfig) {
    try {
      await MacMiniPlugin.sshExec(envConfig, 'which node');
    } catch {
      console.log('      Installing Node.js...');
      await MacMiniPlugin.sshExec(
        envConfig,
        'brew install node || (curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs)'
      );
    }
  }
  
  /**
   * Ensure git is installed on the server
   */
  async ensureGitInstalled(envConfig) {
    try {
      await MacMiniPlugin.sshExec(envConfig, 'which git');
    } catch {
      console.log('      Installing git...');
      await MacMiniPlugin.sshExec(
        envConfig,
        'brew install git || sudo apt-get install -y git'
      );
    }
  }
  
  /**
   * Ensure pnpm is installed on the server
   */
  async ensurePnpmInstalled(envConfig) {
    try {
      await MacMiniPlugin.sshExec(envConfig, 'which pnpm');
    } catch {
      console.log('      Installing pnpm...');
      await MacMiniPlugin.sshExec(envConfig, 'npm install -g pnpm@9');
    }
  }
  
  /**
   * Ensure repository is cloned
   */
  async ensureRepoCloned(envConfig, repoUrl, repoDir, repoName) {
    const checkExists = await MacMiniPlugin.sshExec(
      envConfig,
      `test -d ${repoDir}/.git && echo "exists" || echo "missing"`
    );
    
    if (checkExists.includes('missing')) {
      console.log('      Cloning repository...');
      
      // Extract GitHub repo from URL if provided, otherwise use GITHUB_REPO env var
      let gitUrl = repoUrl;
      if (repoUrl && !repoUrl.startsWith('git@') && !repoUrl.startsWith('https://')) {
        // Format: owner/repo
        gitUrl = `git@github.com:${repoUrl}.git`;
      }
      
      await MacMiniPlugin.sshExec(
        envConfig,
        `mkdir -p ~/.factiii && cd ~/.factiii && git clone ${gitUrl} ${repoName}`
      );
    }
  }
  
  /**
   * Pull latest changes and checkout specific commit
   */
  async pullAndCheckout(envConfig, repoDir, branch, commitHash) {
    console.log(`      Checking out ${branch}${commitHash ? ' @ ' + commitHash.substring(0, 7) : ''}...`);
    
    let commands = [
      `cd ${repoDir}`,
      'git fetch --all',
      `git checkout ${branch}`,
      `git pull origin ${branch}`
    ];
    
    // If commit hash provided, checkout that specific commit
    if (commitHash) {
      commands.push(`git checkout ${commitHash}`);
    }
    
    await MacMiniPlugin.sshExec(envConfig, commands.join(' && '));
  }
  
  /**
   * Install dependencies using pnpm
   */
  async installDependencies(envConfig, repoDir) {
    await MacMiniPlugin.sshExec(
      envConfig,
      `cd ${repoDir} && pnpm install`
    );
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
