/**
 * AWS Pipeline Plugin
 *
 * Cloud infrastructure pipeline for deploying to AWS.
 * Uses a config-based architecture where different configs bundle AWS services:
 * - ec2: Basic EC2 instance
 * - free-tier: Complete free tier bundle (EC2 + RDS + S3 + ECR)
 * - standard: Production-ready setup
 * - enterprise: HA, multi-AZ, auto-scaling
 *
 * This is a PIPELINE plugin, not a server plugin. It handles:
 * - AWS-specific deployment orchestration
 * - ECR image management
 * - AWS service provisioning
 *
 * Server OS plugins (ubuntu, amazon-linux) handle the actual OS-level commands.
 *
 * ============================================================
 * PLUGIN STRUCTURE STANDARD
 * ============================================================
 *
 * **scanfix/** - Scan/fix operations organized by concern
 *   - Each file exports an array of Fix[] objects
 *   - Files group related fixes together (aws-cli, config)
 *   - All fixes are combined in the main plugin class
 *
 * **Environment-specific files** - Operations for each environment
 *   - dev.ts - Dev environment operations (deployDev)
 *   - prod.ts - Production operations (deployProd, ensureServerReady)
 *
 * **configs/** - AWS configuration types
 *   - types.ts - Standardized AWSConfigDef interface
 *   - ec2.ts - EC2 config implementation
 *   - free-tier.ts - Free tier config implementation
 *   - index.ts - Exports all configs
 *
 * **index.ts** - Main plugin class
 *   - Static metadata (id, name, category, version)
 *   - compatibleServers - Which OS types this pipeline supports
 *   - canReach() - Pipeline routing logic
 *   - Imports and combines all scanfix arrays
 * ============================================================
 */

import { execSync } from 'child_process';
import type {
  FactiiiConfig,
  EnvironmentConfig,
  DeployResult,
  EnsureServerReadyOptions,
  Stage,
  Reachability,
  ServerOS,
} from '../../../types/index.js';

// Import shared scanfix factories
import {
  getDockerFixes,
} from '../../../scanfix/index.js';

// Import plugin-specific scanfix arrays
import { awsCliFixes } from './scanfix/aws-cli.js';
import { configFixes } from './scanfix/config.js';
import { credentialsFixes } from './scanfix/credentials.js';
import { vpcFixes } from './scanfix/vpc.js';
import { securityGroupFixes } from './scanfix/security-groups.js';
import { ec2Fixes } from './scanfix/ec2.js';
import { rdsFixes } from './scanfix/rds.js';
import { s3Fixes } from './scanfix/s3.js';
import { ecrFixes } from './scanfix/ecr.js';
import { sesFixes } from './scanfix/ses.js';
import { iamFixes } from './scanfix/iam.js';
import { dbReplicationFixes } from './scanfix/db-replication.js';

// Import environment-specific operations
import { deployDev } from './dev.js';
import { deployProd, ensureServerReady as prodEnsureServerReady } from './prod.js';

// Import configs
import ec2Config from './configs/ec2.js';
import freeTierConfig from './configs/free-tier.js';
import type { AWSConfigDef } from './configs/types.js';

// Import SSH helpers
import { sshExec, findSshKeyForStage, sshRemoteFactiiiCommand, getEnvConfigForStage } from '../../../utils/ssh-helper.js';

type AWSConfigType = 'ec2' | 'free-tier' | 'standard' | 'enterprise';

class AWSPipeline {
  // ============================================================
  // STATIC METADATA
  // ============================================================

  static readonly id = 'aws';
  static readonly name = 'AWS Pipeline';
  static readonly category: 'pipeline' = 'pipeline';
  static readonly version = '1.0.0';

  /**
   * Server OS types this pipeline is compatible with
   * AWS typically runs Ubuntu or Amazon Linux on EC2
   */
  static readonly compatibleServers: ServerOS[] = ['ubuntu', 'amazon-linux'];

  /**
   * Default server OS for this pipeline
   */
  static readonly defaultServer: ServerOS = 'ubuntu';

  // Env vars this plugin requires
  static readonly requiredEnvVars: string[] = [];

  // Schema for stack.yml (user-editable)
  static readonly configSchema: Record<string, unknown> = {
    aws: {
      config: 'ec2', // Options: ec2, free-tier, standard, enterprise
      access_key_id: 'EXAMPLE-AKIAXXXXXXXX',
      region: 'us-east-1',
    },
  };

  // Schema for factiiiAuto.yml (auto-detected + provisioned resource IDs)
  static readonly autoConfigSchema: Record<string, string> = {
    aws_cli_installed: 'boolean',
    aws_vpc_id: 'string',
    aws_subnet_public_id: 'string',
    aws_subnet_private_ids: 'string[]',
    aws_sg_ec2_id: 'string',
    aws_sg_rds_id: 'string',
    aws_ec2_instance_id: 'string',
    aws_ec2_public_ip: 'string',
    aws_rds_endpoint: 'string',
    aws_rds_db_name: 'string',
    aws_s3_bucket: 'string',
    aws_ecr_registry: 'string',
  };

  /**
   * Determine if this plugin should be loaded for this project
   * Loads if any environment has pipeline: 'aws' or aws config
   */
  static async shouldLoad(_rootDir: string, config: FactiiiConfig): Promise<boolean> {
    // Dynamic import to avoid circular dependencies
    const { extractEnvironments } = await import('../../../utils/config-helpers.js');

    const environments = extractEnvironments(config);

    for (const env of Object.values(environments)) {
      // Load if environment explicitly uses 'aws' pipeline
      if (env.pipeline === 'aws') {
        return true;
      }

      // Load if environment has AWS-specific config
      if (env.config && ['ec2', 'free-tier', 'standard', 'enterprise'].includes(env.config)) {
        return true;
      }

      // Load if environment has access_key_id
      if (env.access_key_id) {
        return true;
      }
    }

    // Also load if top-level aws config exists
    if (config.aws?.config || config.aws?.access_key_id) {
      return true;
    }

    return false;
  }

  // Available configurations
  static configs: Record<string, AWSConfigDef> = {
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

   Get from AWS Console: IAM -> Users -> Security credentials`,
  };

  // ============================================================
  // PIPELINE-SPECIFIC METHODS
  // ============================================================

  /**
   * Check how this pipeline can reach a given stage
   * This is the core routing logic for the pipeline
   *
   * Only claims environments where pipeline: 'aws' or aws config exists.
   * For staging/prod: checks SSH key first, falls back to workflow.
   */
  static canReach(stage: Stage, config: FactiiiConfig): Reachability {
    // Check if this stage has environments owned by this pipeline
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getEnvironmentsForStage } = require('../../../utils/config-helpers.js');
    const envs = getEnvironmentsForStage(config, stage);
    const envValues = Object.values(envs) as EnvironmentConfig[];

    switch (stage) {
      case 'dev':
        // Dev is always reachable locally (for AWS CLI checks)
        return { reachable: true, via: 'local' };

      case 'secrets':
        // Secrets stage: check if AWS credentials are available
        // Check Ansible Vault first (same pattern as factiii pipeline)
        if (config.ansible?.vault_path) {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const os = require('os');
          const vaultPasswordFile = config.ansible.vault_password_file?.replace(/^~/, os.homedir());
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const fsCheck = require('fs');
          const hasPasswordFile = vaultPasswordFile && fsCheck.existsSync(vaultPasswordFile);
          const hasPasswordEnv = !!process.env.ANSIBLE_VAULT_PASSWORD || !!process.env.ANSIBLE_VAULT_PASSWORD_FILE;
          if (hasPasswordFile || hasPasswordEnv) {
            return { reachable: true, via: 'local' };
          }
        }
        // Fallback: check env vars directly
        if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
          return { reachable: true, via: 'api' };
        }
        return { reachable: false, reason: 'Missing AWS credentials. Configure Ansible Vault or set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY env vars.' };

      case 'staging':
      case 'prod':
        // Only handle environments that belong to this pipeline
        if (envValues.length === 0) {
          return { reachable: false, reason: 'No ' + stage + ' environment configured' };
        }
        const hasAwsEnv = envValues.some(e => e.pipeline === 'aws' || e.config || e.access_key_id);
        if (!hasAwsEnv) {
          return { reachable: false, reason: 'No AWS environment for ' + stage };
        }

        // On server: run locally
        if (process.env.GITHUB_ACTIONS === 'true' || process.env.FACTIII_ON_SERVER === 'true') {
          return { reachable: true, via: 'local' };
        }

        // Check if the server actually exists (domain is set and not EXAMPLE-)
        // If no real domain, SSH is pointless — run provisioning locally via AWS CLI
        {
          const firstEnvForStage = envValues[0];
          const domain = firstEnvForStage?.domain;
          const hasRealDomain = domain && !domain.startsWith('EXAMPLE-');

          if (hasRealDomain) {
            // Server exists — check for SSH key (direct SSH from dev machine)
            const sshKey = findSshKeyForStage(stage);
            if (sshKey) {
              return { reachable: true, via: 'ssh' };
            }

            // Fallback: use GitHub workflow
            if (process.env.GITHUB_TOKEN) {
              return { reachable: true, via: 'workflow' };
            }
          }
        }

        // AWS provisioning fixes run locally on dev machine (AWS CLI)
        // This handles: no server yet, no SSH key, no GITHUB_TOKEN
        return { reachable: true, via: 'local' };

      default:
        return { reachable: false, reason: 'Unknown stage: ' + stage };
    }
  }

  /**
   * Whether this pipeline requires full repo on server
   * - staging: true (builds from source)
   * - prod: false (pulls pre-built images from ECR)
   */
  static requiresFullRepo(environment: string): boolean {
    return environment === 'staging' || environment.startsWith('staging');
  }

  // ============================================================
  // FIXES - All issues this plugin can detect and resolve
  // ============================================================
  // Combined from scanfix/ folder files
  // Config-specific fixes are merged at runtime
  // ============================================================

  static readonly fixes = [
    // Dev stage - shared fixes
    ...getDockerFixes('dev', 'aws'),

    // Plugin-specific fixes
    ...awsCliFixes,
    ...configFixes,
    ...credentialsFixes,
    ...vpcFixes,
    ...securityGroupFixes,
    ...ec2Fixes,
    ...rdsFixes,
    ...s3Fixes,
    ...ecrFixes,
    ...sesFixes,
    ...iamFixes,
    ...dbReplicationFixes,
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
  private _awsConfig: AWSConfigDef | undefined;

  constructor(config: FactiiiConfig) {
    this._config = config;

    // Load the appropriate AWS config based on stack.yml
    const configName = (config?.aws?.config as AWSConfigType) ?? 'ec2';
    this._awsConfig = AWSPipeline.configs[configName];
  }

  /**
   * Bootstrap a fresh EC2 instance with Node.js and factiii
   * Called before scanStage/fixStage when SSH'ing to a new server
   */
  private async bootstrapServer(stage: Stage): Promise<boolean> {
    const envConfig = getEnvConfigForStage(stage, this._config);
    if (!envConfig) {
      console.log('   [!] No environment config for ' + stage);
      return false;
    }

    const repoName = this._config.name || 'app';

    // Check if Node.js is installed
    try {
      await sshExec(envConfig, 'which node', stage);
    } catch {
      console.log('   Installing Node.js 20 on server...');
      try {
        await sshExec(envConfig, 'curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs', stage);
        console.log('   [OK] Node.js installed');
      } catch (e) {
        console.log('   [!] Failed to install Node.js: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    }

    // Always update factiii to latest version on server
    console.log('   Updating @factiii/stack to latest on server...');
    try {
      await sshExec(envConfig, 'sudo npm install -g @factiii/stack@latest', stage);
      console.log('   [OK] @factiii/stack updated');
    } catch (e) {
      console.log('   [!] Failed to install factiii: ' + (e instanceof Error ? e.message : String(e)));
      return false;
    }

    // Ensure project directory exists and always update stack.yml
    try {
      await sshExec(envConfig, 'mkdir -p ~/.factiii/' + repoName, stage);

      // Always write stack.yml to ensure it's up to date
      const minimalConfig = 'name: ' + repoName + '\\n'
        + 'prod:\\n'
        + '  server: ubuntu\\n'
        + '  pipeline: aws\\n'
        + '  domain: ' + (envConfig.domain || 'localhost') + '\\n'
        + '  ssh_user: ' + (envConfig.ssh_user || 'ubuntu') + '\\n';
      await sshExec(envConfig, 'printf "' + minimalConfig + '" > ~/.factiii/' + repoName + '/stack.yml', stage);
      console.log('   [OK] Server project config updated');
    } catch (e) {
      console.log('   [!] Failed to setup project directory: ' + (e instanceof Error ? e.message : String(e)));
      return false;
    }

    return true;
  }

  /**
   * Scan a stage - handles routing based on canReach()
   *
   * Returns { handled: true } if pipeline ran scan remotely.
   * Returns { handled: false } if caller should run scan locally.
   */
  async scanStage(stage: Stage, _options: Record<string, unknown> = {}): Promise<{ handled: boolean }> {
    const reach = AWSPipeline.canReach(stage, this._config);

    if (!reach.reachable) {
      console.log('\n[X] Cannot reach ' + stage + ': ' + reach.reason);
      return { handled: true };
    }

    if (reach.via === 'ssh') {
      console.log('   Scanning ' + stage + ' via direct SSH...');

      // Bootstrap server if needed (install Node.js, factiii, create dir)
      const bootstrapped = await this.bootstrapServer(stage);
      if (!bootstrapped) {
        console.log('   [!] Server bootstrap failed — cannot scan remotely');
        return { handled: true };
      }

      const sshResult = sshRemoteFactiiiCommand(stage, this._config, 'scan --' + stage);
      if (!sshResult.success) {
        console.log('   [!] ' + stage + ' scan failed: ' + sshResult.stderr);
      }
      return { handled: true };
    }

    // via: 'local' - caller should run locally
    return { handled: false };
  }

  /**
   * Fix a stage - handles routing based on canReach()
   *
   * Returns { handled: true } if pipeline ran fix remotely.
   * Returns { handled: false } if caller should run fix locally.
   */
  async fixStage(stage: Stage, _options: Record<string, unknown> = {}): Promise<{ handled: boolean }> {
    const reach = AWSPipeline.canReach(stage, this._config);

    if (!reach.reachable) {
      console.log('\n[X] Cannot reach ' + stage + ': ' + reach.reason);
      return { handled: true };
    }

    if (reach.via === 'ssh') {
      console.log('   Fixing ' + stage + ' via direct SSH...');

      // Bootstrap server if needed (install Node.js, factiii, create dir)
      const bootstrapped = await this.bootstrapServer(stage);
      if (!bootstrapped) {
        console.log('   [!] Server bootstrap failed — cannot fix remotely');
        return { handled: true };
      }

      const sshResult = sshRemoteFactiiiCommand(stage, this._config, 'fix --' + stage);
      if (!sshResult.success) {
        console.log('   [!] ' + stage + ' fix failed: ' + sshResult.stderr);
      }
      return { handled: true };
    }

    // via: 'local' - caller should run locally
    return { handled: false };
  }

  /**
   * Deploy to a stage - handles routing based on canReach()
   */
  async deployStage(stage: Stage, options: { branch?: string; commit?: string } = {}): Promise<DeployResult> {
    const reach = AWSPipeline.canReach(stage, this._config);

    if (!reach.reachable) {
      return { success: false, error: reach.reason };
    }

    if (reach.via === 'ssh') {
      console.log('   Deploying ' + stage + ' via direct SSH...');

      // Bootstrap server if needed
      const bootstrapped = await this.bootstrapServer(stage);
      if (!bootstrapped) {
        return { success: false, error: 'Server bootstrap failed' };
      }

      const sshResult = sshRemoteFactiiiCommand(stage, this._config, 'deploy --' + stage);
      if (!sshResult.success) {
        return { success: false, error: sshResult.stderr };
      }
      return { success: true, message: stage + ' deployed via SSH' };
    }

    if (reach.via === 'workflow') {
      return { success: true, message: 'Workflow trigger required for ' + stage };
    }

    // via: 'local' - execute directly
    if (stage === 'dev') {
      return this.deploy(this._config, 'dev');
    } else if (stage === 'prod') {
      return this.deploy(this._config, 'prod');
    }

    return { success: false, error: `Unsupported stage: ${stage}` };
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
    return prodEnsureServerReady(config, environment, options);
  }

  /**
   * Deploy to an environment
   */
  async deploy(config: FactiiiConfig, environment: string): Promise<DeployResult> {
    if (environment === 'dev') {
      return deployDev();
    } else if (environment === 'prod' || environment === 'production') {
      return deployProd(config);
    }

    return { success: false, error: `Unsupported environment: ${environment}` };
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
      const { extractEnvironments } = await import('../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);
      const envConfig = environments.prod ?? environments.production;

      if (!envConfig?.domain) {
        return { success: false, error: 'Production domain not configured' };
      }

      try {
        const repoName = config.name ?? 'app';
        await AWSPipeline.sshExec(
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

export default AWSPipeline;
