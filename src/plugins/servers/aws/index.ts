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

import * as fs from 'fs';
import { execSync } from 'child_process';

import { sshExec } from '../../../utils/ssh-helper.js';
import ec2Config from './configs/ec2.js';
import freeTierConfig from './configs/free-tier.js';
import type {
  FactiiiConfig,
  EnvironmentConfig,
  Fix,
  DeployResult,
  EnsureServerReadyOptions,
} from '../../../types/index.js';

type AWSConfigType = 'ec2' | 'free-tier' | 'standard' | 'enterprise';

class AWSPlugin {
  // ============================================================
  // STATIC METADATA
  // ============================================================

  static readonly id = 'aws';
  static readonly name = 'AWS Server';
  static readonly category: 'server' = 'server';
  static readonly version = '1.0.0';

  // Env vars this plugin requires
  static readonly requiredEnvVars: string[] = [];

  // Schema for factiii.yml (user-editable)
  static readonly configSchema: Record<string, unknown> = {
    aws: {
      config: 'ec2', // Options: ec2, free-tier, standard, enterprise
      access_key_id: 'EXAMPLE-AKIAXXXXXXXX',
      region: 'us-east-1',
    },
  };

  // Schema for factiiiAuto.yml (auto-detected)
  static readonly autoConfigSchema: Record<string, string> = {
    aws_cli_installed: 'boolean',
  };

  /**
   * Determine if this plugin should be loaded for this project
   * Loads if config has AWS settings, prod host looks like AWS, or on init (no config)
   */
  static async shouldLoad(_rootDir: string, config: FactiiiConfig): Promise<boolean> {
    // If config exists with AWS settings, load
    if (config?.aws?.access_key_id && !config.aws.access_key_id.startsWith('EXAMPLE-')) {
      return true;
    }

    // If prod host looks like AWS, load
    const prodHost = config?.environments?.prod?.host;
    if (prodHost && !prodHost.startsWith('EXAMPLE-')) {
      // Check if it's a public IP or AWS hostname
      return (
        /^(\d{1,3}\.){3}\d{1,3}$/.test(prodHost) ||
        prodHost.includes('.compute.amazonaws.com') ||
        prodHost.includes('.aws')
      );
    }

    // On init (no config or EXAMPLE values), load as default prod option
    return Object.keys(config).length === 0 || !config.environments;
  }

  // Available configurations
  static configs: Record<string, typeof ec2Config | typeof freeTierConfig> = {
    ec2: ec2Config,
    'free-tier': freeTierConfig,
  };

  static helpText: Record<string, string> = {
    SSH: `
   SSH private key for accessing the EC2 instance.
   
   Option A: Auto-generate via AWS (recommended)
   - Factiii will create an EC2 Key Pair via AWS API
   
   Option B: Use existing key
   ssh-keygen -t ed25519 -C "deploy-key" -f ~/.ssh/deploy_key`,

    AWS_SECRET_ACCESS_KEY: `
   AWS Secret Access Key
   
   Get from AWS Console: IAM → Users → Security credentials`,
  };

  // ============================================================
  // FIXES - All issues this plugin can detect and resolve
  // ============================================================

  static readonly fixes: Fix[] = [
    // DEV STAGE FIXES (same as Mac Mini for local dev)
    {
      id: 'docker-not-installed-dev',
      stage: 'dev',
      severity: 'critical',
      description: 'Docker is not installed locally',
      scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        try {
          execSync('which docker', { stdio: 'pipe' });
          return false;
        } catch {
          return true;
        }
      },
      fix: null,
      manualFix: 'Install Docker Desktop: https://www.docker.com/products/docker-desktop/',
    },
    {
      id: 'docker-not-running-dev',
      stage: 'dev',
      severity: 'critical',
      description: 'Docker is not running locally',
      scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        try {
          execSync('docker info', { stdio: 'pipe' });
          return false;
        } catch {
          return true;
        }
      },
      fix: null,
      manualFix: 'Start Docker Desktop',
    },
    {
      id: 'aws-cli-not-installed-dev',
      stage: 'dev',
      severity: 'warning',
      description: 'AWS CLI not installed (needed for ECR)',
      scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
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
      manualFix: 'Install AWS CLI: brew install awscli',
    },

    // PROD STAGE FIXES
    {
      id: 'prod-host-missing',
      stage: 'prod',
      severity: 'critical',
      description: 'Production host not configured in factiii.yml',
      scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        // Only check if prod environment is defined in config
        const hasProdEnv =
          config?.environments?.prod || config?.environments?.production;
        if (!hasProdEnv) return false; // Skip check if prod not configured

        return (
          !config?.environments?.prod?.host && !config?.environments?.production?.host
        );
      },
      fix: null,
      manualFix: 'Add environments.prod.host to factiii.yml',
    },
    {
      id: 'prod-aws-config-missing',
      stage: 'prod',
      severity: 'critical',
      description: 'AWS configuration missing in factiii.yml',
      scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        // Only check if prod environment is defined in config
        const hasProdEnv =
          config?.environments?.prod || config?.environments?.production;
        if (!hasProdEnv) return false; // Skip check if prod not configured

        return !config?.aws?.access_key_id || !config?.aws?.region;
      },
      fix: null,
      manualFix: 'Add aws.access_key_id and aws.region to factiii.yml',
    },
    {
      id: 'prod-unreachable',
      stage: 'prod',
      severity: 'critical',
      description: 'Cannot reach production server',
      scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        // Only check if prod environment is defined in config
        const hasProdEnv =
          config?.environments?.prod || config?.environments?.production;
        if (!hasProdEnv) return false; // Skip check if prod not configured

        const host =
          config?.environments?.prod?.host ?? config?.environments?.production?.host;
        if (!host) return false;

        try {
          execSync(`ping -c 1 -W 3 ${host}`, { stdio: 'pipe' });
          return false;
        } catch {
          return true;
        }
      },
      fix: null,
      manualFix: 'Check network connectivity to production server',
    },
    {
      id: 'prod-node-missing',
      stage: 'prod',
      severity: 'critical',
      description: 'Node.js not installed on production server',
      scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        const envConfig =
          config?.environments?.prod ?? config?.environments?.production;
        if (!envConfig) return false;
        if (!envConfig?.host) return false;

        try {
          const result = await AWSPlugin.sshExec(envConfig, 'which node');
          return !result;
        } catch {
          return true;
        }
      },
      fix: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        console.log('   Installing Node.js on production server...');
        const envConfig =
          config?.environments?.prod ?? config?.environments?.production;
        if (!envConfig) return false;
        try {
          await AWSPlugin.sshExec(
            envConfig,
            'curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs'
          );
          return true;
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          console.log(`   Failed: ${errorMessage}`);
          return false;
        }
      },
      manualFix: 'SSH to server and install Node.js via NodeSource',
    },
    {
      id: 'prod-git-missing',
      stage: 'prod',
      severity: 'critical',
      description: 'Git not installed on production server',
      scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        const envConfig =
          config?.environments?.prod ?? config?.environments?.production;
        if (!envConfig) return false;
        if (!envConfig?.host) return false;

        try {
          const result = await AWSPlugin.sshExec(envConfig, 'which git');
          return !result;
        } catch {
          return true;
        }
      },
      fix: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        console.log('   Installing git on production server...');
        const envConfig =
          config?.environments?.prod ?? config?.environments?.production;
        if (!envConfig) return false;
        try {
          await AWSPlugin.sshExec(
            envConfig,
            'sudo apt-get update && sudo apt-get install -y git'
          );
          return true;
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          console.log(`   Failed: ${errorMessage}`);
          return false;
        }
      },
      manualFix: 'SSH to server and install git: sudo apt-get install git',
    },
    {
      id: 'prod-docker-missing',
      stage: 'prod',
      severity: 'critical',
      description: 'Docker not installed on production server',
      scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        // Only check if prod environment is defined in config
        const envConfig =
          config?.environments?.prod ?? config?.environments?.production;
        if (!envConfig) return false; // Skip check if prod not configured
        if (!envConfig?.host) return false;

        try {
          const result = await AWSPlugin.sshExec(envConfig, 'which docker');
          return !result;
        } catch {
          return true;
        }
      },
      fix: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        console.log('   Installing Docker on production server...');
        const envConfig =
          config?.environments?.prod ?? config?.environments?.production;
        if (!envConfig) return false;
        try {
          await AWSPlugin.sshExec(
            envConfig,
            'sudo apt-get update && sudo apt-get install -y docker.io && sudo systemctl enable docker && sudo systemctl start docker && sudo usermod -aG docker $USER'
          );
          return true;
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          console.log(`   Failed: ${errorMessage}`);
          return false;
        }
      },
      manualFix: 'SSH to server and install Docker: curl -fsSL https://get.docker.com | sh',
    },
    {
      id: 'prod-repo-not-cloned',
      stage: 'prod',
      severity: 'warning',
      description: 'Repository not cloned on production server',
      scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        const envConfig =
          config?.environments?.prod ?? config?.environments?.production;
        if (!envConfig) return false;
        if (!envConfig?.host) return false;

        const repoName = config.name ?? 'app';

        try {
          const result = await AWSPlugin.sshExec(
            envConfig,
            `test -d ~/.factiii/${repoName}/.git && echo "exists" || echo "missing"`
          );
          return result.includes('missing');
        } catch {
          return true;
        }
      },
      fix: null, // Will be handled by ensureServerReady()
      manualFix: 'Repository will be cloned automatically on first deployment',
    },
  ];

  // ============================================================
  // STATIC HELPER METHODS
  // ============================================================

  /**
   * Auto-detect AWS configuration
   */
  static async detectConfig(
    _rootDir: string
  ): Promise<{ aws_cli_installed: boolean }> {
    try {
      execSync('which aws', { stdio: 'pipe' });
      return { aws_cli_installed: true };
    } catch {
      return { aws_cli_installed: false };
    }
  }

  /**
   * Execute a command on a remote server via SSH
   */
  static async sshExec(envConfig: EnvironmentConfig, command: string): Promise<string> {
    return await sshExec(envConfig, command);
  }

  // ============================================================
  // INSTANCE METHODS
  // ============================================================

  private _config: FactiiiConfig;
  private _awsConfig: typeof ec2Config | typeof freeTierConfig | undefined;

  constructor(config: FactiiiConfig) {
    this._config = config;

    // Load the appropriate AWS config based on factiii.yml
    const configName = (config?.aws?.config as AWSConfigType) ?? 'ec2';
    this._awsConfig = AWSPlugin.configs[configName];
  }

  /**
   * Ensure server is ready for deployment
   * Installs Node.js, git, clones repo, checks out commit
   * Note: Production doesn't install dependencies (pulls pre-built images)
   */
  async ensureServerReady(
    config: FactiiiConfig,
    environment: string,
    options: EnsureServerReadyOptions = {}
  ): Promise<DeployResult> {
    if (environment !== 'prod' && environment !== 'production') {
      return { success: true, message: 'AWS only handles production' };
    }

    const envConfig =
      config.environments?.prod ?? config.environments?.production;
    if (!envConfig?.host) {
      throw new Error('Production host not configured');
    }

    const { commitHash, branch = 'main', repoUrl } = options;
    const repoName = config.name ?? 'app';
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

      // Note: Production doesn't install dependencies - it pulls pre-built images from ECR

      return { success: true, message: 'Server ready' };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to prepare server: ${errorMessage}`);
    }
  }

  /**
   * Ensure Node.js is installed on the server
   */
  private async ensureNodeInstalled(envConfig: EnvironmentConfig): Promise<void> {
    try {
      await AWSPlugin.sshExec(envConfig, 'which node');
    } catch {
      console.log('      Installing Node.js...');
      await AWSPlugin.sshExec(
        envConfig,
        'curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs'
      );
    }
  }

  /**
   * Ensure git is installed on the server
   */
  private async ensureGitInstalled(envConfig: EnvironmentConfig): Promise<void> {
    try {
      await AWSPlugin.sshExec(envConfig, 'which git');
    } catch {
      console.log('      Installing git...');
      await AWSPlugin.sshExec(envConfig, 'sudo apt-get update && sudo apt-get install -y git');
    }
  }

  /**
   * Ensure repository is cloned
   */
  private async ensureRepoCloned(
    envConfig: EnvironmentConfig,
    repoUrl: string | undefined,
    repoDir: string,
    repoName: string
  ): Promise<void> {
    const checkExists = await AWSPlugin.sshExec(
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

      await AWSPlugin.sshExec(
        envConfig,
        `mkdir -p ~/.factiii && cd ~/.factiii && git clone ${gitUrl} ${repoName}`
      );
    }
  }

  /**
   * Pull latest changes and checkout specific commit
   */
  private async pullAndCheckout(
    envConfig: EnvironmentConfig,
    repoDir: string,
    branch: string,
    commitHash: string | undefined
  ): Promise<void> {
    console.log(
      `      Checking out ${branch}${commitHash ? ' @ ' + commitHash.substring(0, 7) : ''}...`
    );

    const commands = [
      `cd ${repoDir}`,
      'git fetch --all',
      `git checkout ${branch}`,
      `git pull origin ${branch}`,
    ];

    // If commit hash provided, checkout that specific commit
    if (commitHash) {
      commands.push(`git checkout ${commitHash}`);
    }

    await AWSPlugin.sshExec(envConfig, commands.join(' && '));
  }

  /**
   * Deploy to an environment
   */
  async deploy(config: FactiiiConfig, environment: string): Promise<DeployResult> {
    if (environment === 'dev') {
      return this.deployDev();
    } else if (environment === 'prod' || environment === 'production') {
      return this.deployProd(config);
    }

    return { success: false, error: `Unsupported environment: ${environment}` };
  }

  /**
   * Deploy to local dev environment
   */
  private async deployDev(): Promise<DeployResult> {
    console.log('   🐳 Starting local dev containers...');

    try {
      const composeFile = fs.existsSync('docker-compose.yml')
        ? 'docker-compose.yml'
        : fs.existsSync('compose.yml')
          ? 'compose.yml'
          : null;

      if (composeFile) {
        execSync(`docker compose -f ${composeFile} up -d`, { stdio: 'inherit' });
        return { success: true, message: 'Local containers started' };
      } else {
        console.log('   No docker-compose.yml found, skipping container start');
        return { success: true, message: 'No compose file, skipped' };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Deploy to production server (pull from ECR)
   */
  private async deployProd(config: FactiiiConfig): Promise<DeployResult> {
    const envConfig =
      config.environments?.prod ?? config.environments?.production;
    if (!envConfig?.host) {
      return { success: false, error: 'Production host not configured' };
    }

    console.log(`   🚀 Deploying to production (${envConfig.host})...`);

    try {
      const repoName = config.name ?? 'app';
      const region = config.aws?.region ?? 'us-east-1';

      // Login to ECR and pull latest image
      await AWSPlugin.sshExec(
        envConfig,
        `
        aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin $(aws sts get-caller-identity --query Account --output text).dkr.ecr.${region}.amazonaws.com && \
        cd ~/.factiii && \
        docker compose pull ${repoName}-prod && \
        docker compose up -d ${repoName}-prod
      `
      );

      return { success: true, message: 'Production deployment complete' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Undeploy from an environment
   */
  async undeploy(config: FactiiiConfig, environment: string): Promise<DeployResult> {
    if (environment === 'dev') {
      try {
        execSync('docker compose down', { stdio: 'inherit' });
        return { success: true, message: 'Local containers stopped' };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } else if (environment === 'prod' || environment === 'production') {
      const envConfig =
        config.environments?.prod ?? config.environments?.production;
      if (!envConfig?.host) {
        return { success: false, error: 'Production host not configured' };
      }

      try {
        const repoName = config.name ?? 'app';
        await AWSPlugin.sshExec(
          envConfig,
          `
          cd ~/.factiii && docker compose stop ${repoName}-prod
        `
        );
        return { success: true, message: 'Production containers stopped' };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return { success: false, error: `Unsupported environment: ${environment}` };
  }
}

export default AWSPlugin;

