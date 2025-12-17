/**
 * AWS Server Plugin
 * 
 * Deploys containers to AWS infrastructure.
 * Uses a config-based architecture where different configs bundle AWS services:
 * - ec2: Basic EC2 instance
 * - free-tier: Complete free tier bundle (EC2 + RDS + S3 + ECR)
 * - standard: Production-ready setup
 * - enterprise: HA, multi-AZ, auto-scaling
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

class AWSPlugin {
  // ============================================================
  // STATIC METADATA
  // ============================================================
  
  static id = 'aws';
  static name = 'AWS Server';
  static category = 'server';
  static version = '1.0.0';
  
  // Env vars this plugin requires
  static requiredEnvVars = [];
  
  // Available configurations
  static configs = {
    'ec2': require('./configs/ec2'),
    'free-tier': require('./configs/free-tier')
    // 'standard': require('./configs/standard'),
    // 'enterprise': require('./configs/enterprise')
  };
  
  static helpText = {
    SSH: `
   SSH private key for accessing the EC2 instance.
   
   Option A: Auto-generate via AWS (recommended)
   - Factiii will create an EC2 Key Pair via AWS API
   
   Option B: Use existing key
   ssh-keygen -t ed25519 -C "deploy-key" -f ~/.ssh/deploy_key`,
    
    AWS_SECRET_ACCESS_KEY: `
   AWS Secret Access Key
   
   Get from AWS Console: IAM → Users → Security credentials`
  };
  
  // ============================================================
  // FIXES - All issues this plugin can detect and resolve
  // ============================================================
  
  static fixes = [
    // DEV STAGE FIXES (same as Mac Mini for local dev)
    {
      id: 'docker-not-installed-dev',
      stage: 'dev',
      severity: 'critical',
      description: 'Docker is not installed locally',
      scan: async (config, rootDir) => {
        try {
          execSync('which docker', { stdio: 'pipe' });
          return false;
        } catch {
          return true;
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
          return false;
        } catch {
          return true;
        }
      },
      fix: null,
      manualFix: 'Start Docker Desktop'
    },
    {
      id: 'aws-cli-not-installed-dev',
      stage: 'dev',
      severity: 'warning',
      description: 'AWS CLI not installed (needed for ECR)',
      scan: async (config, rootDir) => {
        // Only check if AWS is configured
        if (!config?.aws?.access_key_id) return false;
        
        try {
          execSync('which aws', { stdio: 'pipe' });
          return false;
        } catch {
          return true;
        }
      },
      fix: null,
      manualFix: 'Install AWS CLI: brew install awscli'
    },
    
    // PROD STAGE FIXES
    {
      id: 'prod-host-missing',
      stage: 'prod',
      severity: 'critical',
      description: 'Production host not configured in factiii.yml',
      scan: async (config, rootDir) => {
        return !config?.environments?.prod?.host && 
               !config?.environments?.production?.host;
      },
      fix: null,
      manualFix: 'Add environments.prod.host to factiii.yml'
    },
    {
      id: 'prod-aws-config-missing',
      stage: 'prod',
      severity: 'critical',
      description: 'AWS configuration missing in factiii.yml',
      scan: async (config, rootDir) => {
        return !config?.aws?.access_key_id || !config?.aws?.region;
      },
      fix: null,
      manualFix: 'Add aws.access_key_id and aws.region to factiii.yml'
    },
    {
      id: 'prod-unreachable',
      stage: 'prod',
      severity: 'critical',
      description: 'Cannot reach production server',
      scan: async (config, rootDir) => {
        const host = config?.environments?.prod?.host || 
                    config?.environments?.production?.host;
        if (!host) return false;
        
        try {
          execSync(`ping -c 1 -W 3 ${host}`, { stdio: 'pipe' });
          return false;
        } catch {
          return true;
        }
      },
      fix: null,
      manualFix: 'Check network connectivity to production server'
    },
    {
      id: 'prod-docker-missing',
      stage: 'prod',
      severity: 'critical',
      description: 'Docker not installed on production server',
      scan: async (config, rootDir) => {
        const envConfig = config?.environments?.prod || config?.environments?.production;
        if (!envConfig?.host) return false;
        
        try {
          const result = await AWSPlugin.sshExec(envConfig, 'which docker');
          return !result;
        } catch {
          return true;
        }
      },
      fix: async (config, rootDir) => {
        console.log('   Installing Docker on production server...');
        const envConfig = config?.environments?.prod || config?.environments?.production;
        try {
          await AWSPlugin.sshExec(envConfig, 
            'sudo apt-get update && sudo apt-get install -y docker.io && sudo systemctl enable docker && sudo systemctl start docker && sudo usermod -aG docker $USER'
          );
          return true;
        } catch (e) {
          console.log(`   Failed: ${e.message}`);
          return false;
        }
      },
      manualFix: 'SSH to server and install Docker: curl -fsSL https://get.docker.com | sh'
    }
  ];
  
  // ============================================================
  // STATIC HELPER METHODS
  // ============================================================
  
  /**
   * Execute a command on a remote server via SSH
   */
  static async sshExec(envConfig, command) {
    const host = envConfig.host;
    const user = envConfig.ssh_user || 'ubuntu';
    
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
    
    // Load the appropriate AWS config based on factiii.yml
    const configName = config?.aws?.config || 'ec2';
    this.awsConfig = AWSPlugin.configs[configName];
  }
  
  /**
   * Deploy to an environment
   */
  async deploy(config, environment) {
    if (environment === 'dev') {
      return this.deployDev(config);
    } else if (environment === 'prod' || environment === 'production') {
      return this.deployProd(config);
    }
    
    return { success: false, error: `Unsupported environment: ${environment}` };
  }
  
  /**
   * Deploy to local dev environment
   */
  async deployDev(config) {
    console.log('   🐳 Starting local dev containers...');
    
    try {
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
   * Deploy to production server (pull from ECR)
   */
  async deployProd(config) {
    const envConfig = config.environments?.prod || config.environments?.production;
    if (!envConfig?.host) {
      return { success: false, error: 'Production host not configured' };
    }
    
    console.log(`   🚀 Deploying to production (${envConfig.host})...`);
    
    try {
      const repoName = config.name || 'app';
      const region = config.aws?.region || 'us-east-1';
      
      // Login to ECR and pull latest image
      await AWSPlugin.sshExec(envConfig, `
        aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin $(aws sts get-caller-identity --query Account --output text).dkr.ecr.${region}.amazonaws.com && \
        cd ~/.factiii && \
        docker compose pull ${repoName}-prod && \
        docker compose up -d ${repoName}-prod
      `);
      
      return { success: true, message: 'Production deployment complete' };
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
    } else if (environment === 'prod' || environment === 'production') {
      const envConfig = config.environments?.prod || config.environments?.production;
      if (!envConfig?.host) {
        return { success: false, error: 'Production host not configured' };
      }
      
      try {
        const repoName = config.name || 'app';
        await AWSPlugin.sshExec(envConfig, `
          cd ~/.factiii && docker compose stop ${repoName}-prod
        `);
        return { success: true, message: 'Production containers stopped' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    
    return { success: false, error: `Unsupported environment: ${environment}` };
  }
}

module.exports = AWSPlugin;
