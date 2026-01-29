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
  getNodeFixes,
  getGitFixes,
  createCertbotFix,
} from '../../../scanfix/index.js';

// Import plugin-specific scanfix arrays
import { awsCliFixes } from './scanfix/aws-cli.js';
import { configFixes } from './scanfix/config.js';

// Import environment-specific operations
import { deployDev } from './dev.js';
import { deployProd, ensureServerReady as prodEnsureServerReady } from './prod.js';

// Import configs
import ec2Config from './configs/ec2.js';
import freeTierConfig from './configs/free-tier.js';
import type { AWSConfigDef } from './configs/types.js';

// Import SSH helper
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
   * Loads if config has AWS settings, prod environment uses AWS, or on init
   */
  static async shouldLoad(_rootDir: string, config: FactiiiConfig): Promise<boolean> {
    // Dynamic import to avoid circular dependencies
    const { extractEnvironments } = await import('../../../utils/config-helpers.js');

    const environments = extractEnvironments(config);

    for (const env of Object.values(environments)) {
      // Load if environment explicitly uses 'aws' pipeline
      if (env.pipeline === 'aws') {
        // Verify it has real AWS config (not EXAMPLE values)
        if (env.access_key_id && !env.access_key_id.startsWith('EXAMPLE-')) {
          return true;
        }
      }

      // Check if domain looks like AWS (IP or AWS domain)
      if (env.domain && !env.domain.startsWith('EXAMPLE-')) {
        const isAwsDomain =
          /^(\d{1,3}\.){3}\d{1,3}$/.test(env.domain) ||
          env.domain.includes('.compute.amazonaws.com') ||
          env.domain.includes('.amazonaws.com') ||
          env.domain.includes('.aws');
        if (isAwsDomain) return true;
      }
    }

    // On init (no config or EXAMPLE values), load as default prod option
    return Object.keys(config).length === 0;
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
   */
  static canReach(stage: Stage, config: FactiiiConfig): Reachability {
    switch (stage) {
      case 'dev':
        // Dev is always reachable locally
        return { reachable: true, via: 'local' };

      case 'secrets':
        // Secrets require AWS credentials
        if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
          return { reachable: false, reason: 'Missing AWS credentials (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)' };
        }
        return { reachable: true, via: 'api' };

      case 'staging':
      case 'prod':
        // On server (in workflow): run locally
        if (process.env.GITHUB_ACTIONS === 'true') {
          return { reachable: true, via: 'local' };
        }
        // On dev machine: need to trigger workflow or SSH directly
        return { reachable: true, via: 'workflow' };

      default:
        return { reachable: false, reason: `Unknown stage: ${stage}` };
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

    // Prod stage - shared fixes (for ubuntu/amazon-linux servers)
    ...getDockerFixes('prod'),
    ...getNodeFixes('prod'),
    ...getGitFixes('prod'),
    createCertbotFix('prod', 'prod'),

    // Plugin-specific fixes
    ...awsCliFixes,
    ...configFixes,
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

    // Load the appropriate AWS config based on factiii.yml
    const configName = (config?.aws?.config as AWSConfigType) ?? 'ec2';
    this._awsConfig = AWSPipeline.configs[configName];
  }

  /**
   * Deploy to a stage - handles routing based on canReach()
   */
  async deployStage(stage: Stage, options: { branch?: string; commit?: string } = {}): Promise<DeployResult> {
    const reach = AWSPipeline.canReach(stage, this._config);

    if (!reach.reachable) {
      return { success: false, error: reach.reason };
    }

    if (reach.via === 'workflow') {
      // Would trigger GitHub Actions workflow
      // For now, return message about workflow triggering
      return { success: true, message: `Workflow trigger required for ${stage}` };
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
