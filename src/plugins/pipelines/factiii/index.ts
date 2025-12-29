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
  DeployOptions,
} from '../../../types/index.js';
import { loadRelevantPlugins } from '../../index.js';
import GitHubWorkflowMonitor from '../../../utils/github-workflow-monitor.js';
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
   * Check if this pipeline can reach a specific stage
   *
   * ============================================================
   * PIPELINE AUTHORS: This method controls stage reachability
   * ============================================================
   *
   * Return values:
   *   { reachable: true, via: 'local' } - Run fixes on this machine
   *   { reachable: true, via: 'workflow' } - Trigger workflow to run fixes
   *   { reachable: false, reason: '...' } - Cannot reach, show error
   *
   * For the Factiii pipeline:
   *   - dev: always local
   *   - secrets: needs GITHUB_TOKEN (for GitHub Secrets API)
   *   - staging/prod:
   *       - If GITHUB_ACTIONS=true → local (we're on the server)
   *       - Else → workflow (trigger GitHub Actions)
   *
   * CRITICAL: When your workflow SSHs to a server, it MUST run:
   *   npx factiii [command] --staging  (or --prod)
   *
   * This ensures the command only runs that stage locally.
   * ============================================================
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

        // Workflows must be committed for remote operations
        try {
          const workflowsDir = path.join(process.cwd(), '.github', 'workflows');
          if (fs.existsSync(workflowsDir)) {
            const status = execSync('git status --porcelain .github/workflows/', {
              cwd: process.cwd(),
              encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'ignore'],
            });

            if (status.trim().length > 0) {
              return {
                reachable: false,
                reason: 'GitHub workflows not committed (required for remote operations)',
              };
            }
          }
        } catch {
          // Not a git repo - allow secrets stage to proceed
        }

        return { reachable: true, via: 'github-api' };

      case 'staging':
      case 'prod':
        // If GITHUB_ACTIONS is set, we're running inside a workflow on the server
        // Return 'local' so fixes run directly without triggering another workflow
        if (process.env.GITHUB_ACTIONS) {
          return { reachable: true, via: 'local' };
        }

        // On dev machine: need GITHUB_TOKEN to trigger workflows
        if (!process.env.GITHUB_TOKEN) {
          return {
            reachable: false,
            reason: 'Missing GITHUB_TOKEN (required to trigger workflows)',
          };
        }

        // Reach via workflow - workflow will SSH to server and run with --staging/--prod
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

        // Check if using old bloated workflow (has inline bash logic not from template)
        if (content.includes('docker compose build')) return true;

        // Check version comment
        const packageJsonPath = path.join(__dirname, '../../../../package.json');
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const currentVersion = packageJson.version;

        const versionMatch = content.match(/# Generated by @factiii\/stack v([\d.]+)/);
        if (!versionMatch) return true; // No version comment = outdated

        const workflowVersion = versionMatch[1];
        return workflowVersion !== currentVersion;
      },
      fix: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        await FactiiiPipeline.generateWorkflows(rootDir);
        return true;
      },
      manualFix: 'Run: npx factiii fix (will regenerate thin workflows)',
    },
    {
      id: 'orphaned-workflows',
      stage: 'dev',
      severity: 'warning',
      description: 'Old workflow files found that are not generated by current version',
      scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        const workflowsDir = path.join(rootDir, '.github', 'workflows');
        if (!fs.existsSync(workflowsDir)) return false;

        // List of workflows we currently generate
        const validWorkflows = [
          'factiii-deploy.yml',
          'factiii-fix.yml',
          'factiii-scan.yml',
          'factiii-undeploy.yml',
          'factiii-cicd-staging.yml',
          'factiii-cicd-prod.yml',
          'factiii-dev-sync.yml', // Only in dev mode
        ];

        // Find all factiii-*.yml files
        const files = fs.readdirSync(workflowsDir);
        const factiiiFiles = files.filter((f) => f.startsWith('factiii-') && f.endsWith('.yml'));

        // Check for orphaned files
        const orphaned = factiiiFiles.filter((f) => !validWorkflows.includes(f));

        return orphaned.length > 0;
      },
      fix: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        const workflowsDir = path.join(rootDir, '.github', 'workflows');

        const validWorkflows = [
          'factiii-deploy.yml',
          'factiii-fix.yml',
          'factiii-scan.yml',
          'factiii-undeploy.yml',
          'factiii-cicd-staging.yml',
          'factiii-cicd-prod.yml',
          'factiii-dev-sync.yml',
        ];

        const files = fs.readdirSync(workflowsDir);
        const factiiiFiles = files.filter((f) => f.startsWith('factiii-') && f.endsWith('.yml'));
        const orphaned = factiiiFiles.filter((f) => !validWorkflows.includes(f));

        for (const file of orphaned) {
          const filePath = path.join(workflowsDir, file);
          fs.unlinkSync(filePath);
          console.log(`   🗑️  Deleted orphaned workflow: ${file}`);
        }

        return orphaned.length > 0;
      },
      manualFix: 'Run: npx factiii fix (will remove old workflow files)',
    },
    {
      id: 'workflows-uncommitted',
      stage: 'dev',
      severity: 'critical',
      description: 'GitHub workflows not committed to git',
      scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        const workflowsDir = path.join(rootDir, '.github', 'workflows');
        if (!fs.existsSync(workflowsDir)) return false;

        try {
          // Check git status for workflow files
          const status = execSync('git status --porcelain .github/workflows/', {
            cwd: rootDir,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
          });

          // If there's any output, workflows are uncommitted or untracked
          return status.trim().length > 0;
        } catch {
          // Not a git repo or git not available
          return false;
        }
      },
      fix: null, // Cannot auto-commit
      manualFix:
        'Commit and push workflows: git add .github/workflows/ && git commit -m "Update workflows" && git push',
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
        const hasProdEnv = config?.environments?.prod;
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

    // Get package version
    const packageJsonPath = path.join(__dirname, '../../../../package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const version = packageJson.version;

    // Create .github/workflows if it doesn't exist
    if (!fs.existsSync(workflowsDir)) {
      fs.mkdirSync(workflowsDir, { recursive: true });
    }

    // Copy workflow files and inject version
    // Infrastructure management (manual dispatch):
    //   - factiii-deploy.yml: Manual deploy with --staging or --prod
    //   - factiii-fix.yml: Manual fix with matrix for all configured envs
    //   - factiii-scan.yml: Manual scan with matrix for all configured envs
    //   - factiii-undeploy.yml: Manual cleanup
    // CI/CD (auto on push):
    //   - factiii-cicd-staging.yml: Auto-deploy on push to main
    //   - factiii-cicd-prod.yml: Auto-deploy on push to prod
    const workflows = [
      'factiii-deploy.yml',
      'factiii-fix.yml',
      'factiii-scan.yml',
      'factiii-undeploy.yml',
      'factiii-cicd-staging.yml',
      'factiii-cicd-prod.yml',
    ];

    // Only add dev-sync workflow in dev mode
    if (process.env.DEV_MODE === 'true') {
      workflows.push('factiii-dev-sync.yml');
    }

    for (const workflow of workflows) {
      const sourcePath = path.join(sourceDir, workflow);
      const destPath = path.join(workflowsDir, workflow);

      if (fs.existsSync(sourcePath)) {
        let content = fs.readFileSync(sourcePath, 'utf8');

        // Replace version placeholder with actual version
        content = content.replace(/v\{VERSION\}/g, `v${version}`);

        fs.writeFileSync(destPath, content);
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

    // Get current branch
    let ref = 'main';
    try {
      ref = execSync('git rev-parse --abbrev-ref HEAD', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // Fall back to main if we can't detect the branch
    }

    const octokit = new Octokit({ auth: token });

    await octokit.rest.actions.createWorkflowDispatch({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      workflow_id: workflowName,
      ref,
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
   * Deploy to a stage - handles routing based on canReach()
   *
   * This is the main entry point for deployments. Checks canReach() to determine:
   * - 'local': Execute deployment directly (dev stage, or when running on server)
   * - 'workflow': Trigger GitHub Actions workflow
   * - Not reachable: Return error with reason
   */
  async deployStage(stage: Stage, options: DeployOptions = {}): Promise<DeployResult> {
    // Ask canReach() how to reach this stage
    // Pipeline plugin decides based on environment (GITHUB_ACTIONS, etc.)
    const reach = FactiiiPipeline.canReach(stage, this._config);

    if (!reach.reachable) {
      console.log(`\n❌ Cannot reach ${stage}: ${reach.reason}`);
      return { success: false, error: reach.reason };
    }

    if (reach.via === 'workflow') {
      // We're on dev machine, need to trigger GitHub Actions workflow
      // Try to use gh CLI for live monitoring if available
      try {
        const monitor = new GitHubWorkflowMonitor();
        const result = await monitor.triggerAndWatch('factiii-deploy.yml', stage);
        return {
          success: result.success,
          message: result.success ? 'Deployment complete' : undefined,
          error: result.error,
        };
      } catch {
        // Fall back to API-based trigger without live monitoring
        console.log(`   Triggering ${stage} deployment via GitHub Actions...`);

        try {
          await FactiiiPipeline.triggerWorkflow('factiii-deploy.yml', {
            environment: stage,
          });

          const repoInfo = GitHubSecretsStore.getRepoInfo();
          if (repoInfo) {
            console.log(`   Check: https://github.com/${repoInfo.owner}/${repoInfo.repo}/actions\n`);
          }

          return { success: true, message: 'Workflow triggered - check GitHub Actions for progress' };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return { success: false, error: `Failed to trigger workflow: ${errorMessage}` };
        }
      }
    }

    // via: 'local' - we can run directly (dev stage, or on-server in workflow)
    return this.runLocalDeploy(stage, options);
  }

  /**
   * Run deployment locally by delegating to server plugin
   */
  private async runLocalDeploy(stage: Stage, options: DeployOptions): Promise<DeployResult> {
    const rootDir = options.rootDir ?? process.cwd();

    // Load plugins and find server plugin
    const plugins = await loadRelevantPlugins(rootDir, this._config);
    const ServerPluginClass = plugins.find((p) => p.category === 'server') as {
      new (config: FactiiiConfig): {
        ensureServerReady?(
          config: FactiiiConfig,
          environment: string,
          options?: Record<string, string>
        ): Promise<DeployResult>;
        deploy(config: FactiiiConfig, environment: string): Promise<DeployResult>;
      };
    } | undefined;

    if (!ServerPluginClass) {
      return { success: false, error: 'No server plugin found' };
    }

    try {
      const serverInstance = new ServerPluginClass(this._config);

      // Ensure server is ready (install deps, clone repo, etc.)
      if (serverInstance.ensureServerReady) {
        console.log('   Preparing server...');
        
        // Get repo URL from environment or config
        const repoUrl = process.env.GITHUB_REPO || this._config.github_repo || '';
        
        await serverInstance.ensureServerReady(this._config, stage, {
          branch: options.branch ?? 'main',
          commitHash: options.commit ?? '',
          repoUrl: repoUrl,
        });
      }

      // Run the actual deployment
      return serverInstance.deploy(this._config, stage);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Deploy to an environment
   * @deprecated Use deployStage() which handles routing based on canReach()
   */
  async deploy(_config: FactiiiConfig, environment: string): Promise<DeployResult> {
    // For backwards compatibility, delegate to deployStage
    return this.deployStage(environment as Stage, {});
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

