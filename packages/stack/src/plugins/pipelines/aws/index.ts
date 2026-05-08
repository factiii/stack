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
  Fix,
  Stage,
  Reachability,
  ServerOS,
} from '../../../types/index.js';

// AWS scanfix arrays are imported by factiii pipeline (factiii/index.ts)
// to avoid duplicates when both plugins load. Docker is handled by server plugins.

// Import environment-specific operations
import { deployDev } from './dev.js';
import { deployProd, ensureServerReady as prodEnsureServerReady } from './prod.js';

// Import configs
import ec2Config from './configs/ec2.js';
import freeTierConfig from './configs/free-tier.js';
import type { AWSConfigDef } from './configs/types.js';

// Import SSH helpers
import { sshExec } from '../../../utils/ssh-helper.js';

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
      access_key_id: 'EXAMPLE_AKIAXXXXXXXX',
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

      case 'staging':
      case 'prod': {
        // Dev-direct: AWS scanfixes hit AWS APIs from the dev machine; any
        // server-state checks go through the per-stage SSH tunnel. No more
        // via: 'ssh' / 'workflow' branches — the dev CLI owns the run.
        if (envValues.length === 0) {
          return { reachable: false, reason: 'No ' + stage + ' environment configured' };
        }
        const hasAwsEnv = envValues.some(e => e.config || e.access_key_id);
        if (!hasAwsEnv) {
          return { reachable: false, reason: 'No AWS environment for ' + stage };
        }
        return { reachable: true, via: 'local' };
      }

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

  // AWS scanfixes are imported by the factiii pipeline (factiii/index.ts)
  // to avoid duplicates when both plugins load. Docker is handled by server plugins.
  static readonly fixes: Fix[] = [];

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
    // Dev-direct: AWS scanfixes run locally on dev (AWS APIs + tunnel).
    return { handled: false };
  }

  /**
   * Fix a stage — dev-direct, always runs locally.
   */
  async fixStage(stage: Stage, _options: Record<string, unknown> = {}): Promise<{ handled: boolean }> {
    const reach = AWSPipeline.canReach(stage, this._config);
    if (!reach.reachable) {
      console.log('\n[X] Cannot reach ' + stage + ': ' + reach.reason);
      return { handled: true };
    }
    return { handled: false };
  }

  /**
   * Deploy to a stage — dev-direct. dev/prod wired to deploy(); staging
   * goes through the factiii pipeline's runLocalDeploy (server plugin).
   */
  async deployStage(stage: Stage, _options: { branch?: string; commit?: string } = {}): Promise<DeployResult> {
    const reach = AWSPipeline.canReach(stage, this._config);
    if (!reach.reachable) {
      return { success: false, error: reach.reason };
    }
    if (stage === 'dev') return this.deploy(this._config, 'dev');
    if (stage === 'prod') return this.deploy(this._config, 'prod');
    return { success: false, error: `Unsupported stage: ${stage}` };
  }

  /**
   * Ensure server is ready for deployment.
   *
   * Prod servers run pre-built ECR images, so this only writes per-stage
   * state (env file + AWS credentials). No node, git, or source on prod.
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
