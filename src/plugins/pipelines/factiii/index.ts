/**
 * Factiii Pipeline Plugin
 *
 * The default pipeline plugin for Factiii Stack.
 * Uses GitHub Actions for CI/CD with thin workflows that SSH to servers
 * and call the Factiii CLI to do the actual work.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { Octokit } from '@octokit/rest';

import type {
  FactiiiConfig,
  Stage,
  Reachability,
  Fix,
  DeployResult,
} from '../../../types/index.js';
import { GitHubSecretsStore } from './github-secrets-store.js';

interface DetectedConfig {
  package_manager: string;
  node_version: string | null;
  pnpm_version: string | null;
  dockerfile: string | null;
}

interface PackageJson {
  engines?: {
    node?: string;
    pnpm?: string;
  };
  packageManager?: string;
}

class FactiiiPipeline {
  // ============================================================
  // STATIC METADATA
  // ============================================================

  static readonly id = 'factiii';
  static readonly name = 'Factiii Pipeline';
  static readonly category: 'pipeline' = 'pipeline';
  static readonly version = '1.0.0';

  // Env vars this plugin requires (none - pipeline doesn't need app env vars)
  static readonly requiredEnvVars: string[] = [];

  // Schema for factiii.yml (user-editable)
  static readonly configSchema: Record<string, unknown> = {
    // No user config - workflows are auto-generated
  };

  // Schema for factiiiAuto.yml (auto-detected)
  static readonly autoConfigSchema: Record<string, string> = {
    package_manager: 'string',
    node_version: 'string',
    pnpm_version: 'string',
    dockerfile: 'string',
  };

  /**
   * Determine if this plugin should be loaded for this project
   * Pipeline plugin always loads - it's the default CI/CD system
   */
  static async shouldLoad(_rootDir: string, _config: FactiiiConfig): Promise<boolean> {
    return true; // Always load - this is the default pipeline
  }

  /**
   * Whether this environment requires the full repo cloned on the server
   */
  static requiresFullRepo(environment: string): boolean {
    // Staging: needs full repo for local building from source
    // Prod: pulls pre-built images from ECR, only needs factiii.yml + env file
    return environment === 'staging';
  }

  /**
   * Check if this pipeline can reach a specific stage from current environment
   */
  static canReach(stage: Stage, _config: FactiiiConfig): Reachability {
    switch (stage) {
      case 'dev':
        // Dev is always reachable locally
        return { reachable: true, via: 'local' };

      case 'secrets':
        // Need GITHUB_TOKEN to check/set GitHub secrets
        if (!process.env.GITHUB_TOKEN) {
          return {
            reachable: false,
            reason: 'Missing GITHUB_TOKEN environment variable',
          };
        }
        return { reachable: true, via: 'github-api' };

      case 'staging':
      case 'prod':
        // Check if running FROM a workflow (on server)
        if (process.env.GITHUB_ACTIONS) {
          return { reachable: true, via: 'local' }; // We ARE on the server
        }

        // From dev: need to trigger workflow
        // Cannot SSH directly - must use workflow
        return {
          reachable: true,
          via: 'workflow',
        };

      default:
        return { reachable: false, reason: `Unknown stage: ${stage}` };
    }
  }

  // ============================================================
  // FIXES - All issues this plugin can detect and resolve
  // ============================================================

  static readonly fixes: Fix[] = [
    // DEV STAGE FIXES
    {
      id: 'missing-factiii-yml',
      stage: 'dev',
      severity: 'critical',
      description: 'factiii.yml configuration file not found',
      scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        return !fs.existsSync(path.join(rootDir, 'factiii.yml'));
      },
      fix: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        // Generate from plugin schemas
        const { generateFactiiiYml } = await import(
          '../../../generators/generate-factiii-yml.js'
        );
        return generateFactiiiYml(rootDir, { force: false });
      },
      manualFix: 'Run: npx factiii fix (will create factiii.yml from plugin schemas)',
    },
    {
      id: 'gh-cli-not-installed',
      stage: 'dev',
      severity: 'info',
      description: 'GitHub CLI not installed (recommended for deployment monitoring)',
      scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        try {
          execSync('which gh', { stdio: 'pipe' });
          return false;
        } catch {
          return true;
        }
      },
      fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        console.log('   Installing GitHub CLI via Homebrew...');
        try {
          // Check if brew is available
          execSync('which brew', { stdio: 'pipe' });

          // Install gh CLI
          execSync('brew install gh', { stdio: 'inherit' });

          console.log('   ✅ GitHub CLI installed successfully!');
          console.log('   💡 Run: gh auth login');
          return true;
        } catch {
          console.log('   ⚠️  Homebrew not found or installation failed');
          return false;
        }
      },
      manualFix: 'Install GitHub CLI: brew install gh (or visit https://cli.github.com/)',
    },
    {
      id: 'missing-workflows',
      stage: 'dev',
      severity: 'warning',
      description: 'GitHub workflows not generated',
      scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        const workflowsDir = path.join(rootDir, '.github', 'workflows');
        return !fs.existsSync(path.join(workflowsDir, 'factiii-deploy.yml'));
      },
      fix: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        await FactiiiPipeline.generateWorkflows(rootDir);
        return true;
      },
      manualFix: 'Run: npx factiii fix (will generate workflow files)',
    },
    {
      id: 'outdated-workflows',
      stage: 'dev',
      severity: 'info',
      description: 'GitHub workflows may be outdated',
      scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        const workflowPath = path.join(
          rootDir,
          '.github',
          'workflows',
          'factiii-deploy.yml'
        );
        if (!fs.existsSync(workflowPath)) return false;

        const content = fs.readFileSync(workflowPath, 'utf8');
        // Check if using old bloated workflow (has inline bash logic)
        return content.includes('docker compose build') || content.length > 5000;
      },
      fix: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        await FactiiiPipeline.generateWorkflows(rootDir);
        return true;
      },
      manualFix: 'Run: npx factiii fix (will regenerate thin workflows)',
    },

    // SECRETS STAGE FIXES
    {
      id: 'missing-staging-ssh',
      stage: 'secrets',
      severity: 'critical',
      description: 'STAGING_SSH secret not found in GitHub',
      scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        // Only check if staging environment is defined in config
        const hasStagingEnv = config?.environments?.staging;
        if (!hasStagingEnv) return false; // Skip check if staging not configured

        const store = new GitHubSecretsStore({});
        const result = await store.checkSecrets(['STAGING_SSH']);
        return result.missing?.includes('STAGING_SSH') ?? false;
      },
      fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        // This requires interactive prompting - handled by fix.js
        console.log('   Please provide STAGING_SSH key when prompted');
        return false; // Return false to indicate manual intervention needed
      },
      manualFix:
        'Add STAGING_SSH secret at: https://github.com/{owner}/{repo}/settings/secrets/actions',
    },
    {
      id: 'missing-prod-ssh',
      stage: 'secrets',
      severity: 'critical',
      description: 'PROD_SSH secret not found in GitHub',
      scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        // Only check if prod environment is defined in config
        const hasProdEnv =
          config?.environments?.prod || config?.environments?.production;
        if (!hasProdEnv) return false; // Skip check if prod not configured

        const store = new GitHubSecretsStore({});
        const result = await store.checkSecrets(['PROD_SSH']);
        return result.missing?.includes('PROD_SSH') ?? false;
      },
      fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        console.log('   Please provide PROD_SSH key when prompted');
        return false;
      },
      manualFix:
        'Add PROD_SSH secret at: https://github.com/{owner}/{repo}/settings/secrets/actions',
    },
    {
      id: 'missing-aws-secret',
      stage: 'secrets',
      severity: 'warning',
      description: 'AWS_SECRET_ACCESS_KEY not found in GitHub (needed for ECR)',
      scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        // Only check if AWS is configured
        if (!config?.aws?.access_key_id) return false;

        const store = new GitHubSecretsStore({});
        const result = await store.checkSecrets(['AWS_SECRET_ACCESS_KEY']);
        return result.missing?.includes('AWS_SECRET_ACCESS_KEY') ?? false;
      },
      fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        console.log('   Please provide AWS_SECRET_ACCESS_KEY when prompted');
        return false;
      },
      manualFix:
        'Add AWS_SECRET_ACCESS_KEY secret at: https://github.com/{owner}/{repo}/settings/secrets/actions',
    },
  ];

  // ============================================================
  // STATIC METHODS
  // ============================================================

  /**
   * Auto-detect pipeline configuration
   */
  static async detectConfig(rootDir: string): Promise<DetectedConfig> {
    return {
      package_manager: this.detectPackageManager(rootDir),
      node_version: this.detectNodeVersion(rootDir),
      pnpm_version: this.detectPnpmVersion(rootDir),
      dockerfile: this.findDockerfile(rootDir),
    };
  }

  /**
   * Detect package manager
   */
  static detectPackageManager(rootDir: string): string {
    if (fs.existsSync(path.join(rootDir, 'pnpm-lock.yaml'))) {
      return 'pnpm';
    }
    if (fs.existsSync(path.join(rootDir, 'yarn.lock'))) {
      return 'yarn';
    }
    if (fs.existsSync(path.join(rootDir, 'package-lock.json'))) {
      return 'npm';
    }
    return 'npm';
  }

  /**
   * Detect Node.js version from package.json
   */
  static detectNodeVersion(rootDir: string): string | null {
    const packageJsonPath = path.join(rootDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return null;
    }

    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJson;
      if (pkg?.engines?.node) {
        const cleaned = pkg.engines.node.replace(/[^0-9.]/g, '');
        return cleaned || null;
      }
    } catch {
      // Ignore errors
    }

    return null;
  }

  /**
   * Detect pnpm version from package.json
   */
  static detectPnpmVersion(rootDir: string): string | null {
    const packageJsonPath = path.join(rootDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return null;
    }

    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJson;

      if (pkg?.packageManager?.startsWith('pnpm@')) {
        const version = pkg.packageManager.split('@')[1];
        return version?.split('.')[0] ?? null;
      }

      if (pkg?.engines?.pnpm) {
        const cleaned = pkg.engines.pnpm.replace(/[^0-9.]/g, '');
        return cleaned.split('.')[0] ?? null;
      }
    } catch {
      // Ignore errors
    }

    return null;
  }

  /**
   * Find Dockerfile
   */
  static findDockerfile(rootDir: string): string | null {
    const commonPaths = [
      'Dockerfile',
      'apps/server/Dockerfile',
      'packages/server/Dockerfile',
      'backend/Dockerfile',
      'server/Dockerfile',
    ];

    for (const relativePath of commonPaths) {
      if (fs.existsSync(path.join(rootDir, relativePath))) {
        return relativePath;
      }
    }

    return null;
  }

  /**
   * Generate GitHub workflow files in the target repository
   */
  static async generateWorkflows(rootDir: string): Promise<void> {
    const workflowsDir = path.join(rootDir, '.github', 'workflows');
    const sourceDir = path.join(__dirname, 'workflows');

    // Create .github/workflows if it doesn't exist
    if (!fs.existsSync(workflowsDir)) {
      fs.mkdirSync(workflowsDir, { recursive: true });
    }

    // Copy workflow files
    const workflows = [
      'factiii-deploy.yml',
      'factiii-staging.yml',
      'factiii-production.yml',
      'factiii-undeploy.yml',
    ];

    for (const workflow of workflows) {
      const sourcePath = path.join(sourceDir, workflow);
      const destPath = path.join(workflowsDir, workflow);

      if (fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, destPath);
        console.log(`   ✅ Generated ${workflow}`);
      }
    }
  }

  /**
   * Trigger a GitHub Actions workflow
   */
  static async triggerWorkflow(
    workflowName: string,
    inputs: Record<string, string> = {}
  ): Promise<void> {
    const repoInfo = GitHubSecretsStore.getRepoInfo();

    if (!repoInfo) {
      throw new Error('Could not determine GitHub repository');
    }

    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error('GITHUB_TOKEN required to trigger workflows');
    }

    const octokit = new Octokit({ auth: token });

    await octokit.rest.actions.createWorkflowDispatch({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      workflow_id: workflowName,
      ref: 'main',
      inputs,
    });
  }

  // ============================================================
  // INSTANCE METHODS
  // ============================================================

  private _config: FactiiiConfig;

  constructor(config: FactiiiConfig) {
    this._config = config;
  }

  /**
   * Deploy to an environment
   * For pipeline plugins, this triggers the deployment process
   */
  async deploy(_config: FactiiiConfig, environment: string): Promise<DeployResult> {
    if (environment === 'dev') {
      // Dev doesn't use pipeline - handled by server plugin
      return { success: true, message: 'Dev deploy handled by server plugin' };
    }

    // For staging/prod, we're already ON the server (called via SSH from workflow)
    // The pipeline plugin doesn't do the actual deployment - server plugins do
    console.log(`   Pipeline: ${environment} deployment initiated`);
    return { success: true };
  }

  /**
   * Undeploy from an environment
   */
  async undeploy(_config: FactiiiConfig, environment: string): Promise<DeployResult> {
    console.log(`   Pipeline: ${environment} undeploy initiated`);
    return { success: true };
  }
}

export default FactiiiPipeline;

