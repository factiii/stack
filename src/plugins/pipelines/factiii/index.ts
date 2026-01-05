/**
 * Factiii Pipeline Plugin
 *
 * The default pipeline plugin for Factiii Stack.
 * Uses GitHub Actions for CI/CD with thin workflows that SSH to servers
 * and call the Factiii CLI to do the actual work.
 *
 * ============================================================
 * PLUGIN STRUCTURE STANDARD
 * ============================================================
 *
 * This plugin follows a standardized structure for clarity and maintainability:
 *
 * **scanfix/** - Scan/fix operations organized by concern
 *   - Each file exports an array of Fix[] objects
 *   - Files group related fixes together (config, github-cli, workflows, secrets)
 *   - All fixes are combined in the main plugin class
 *
 * **utils/** - Utility methods
 *   - detection.ts - Config detection methods (package manager, Node.js version, etc.)
 *   - workflows.ts - Workflow generation and triggering
 *
 * **index.ts** - Main plugin class
 *   - Static metadata (id, name, category, version)
 *   - shouldLoad() - Determines if plugin should load
 *   - canReach() - Determines how to reach each stage (critical routing method)
 *   - Imports and combines all scanfix arrays
 *   - Imports and uses utility methods
 *   - Core pipeline logic: deployStage(), runLocalDeploy()
 *   - Maintains public API compatibility
 *
 * **Key Differences from Server Plugins:**
 *   - Environment-specific files (staging.ts, prod.ts) are in plugin root - standard pattern
 *   - Core routing logic stays in index.ts - canReach() and deployStage() are the main entry points
 *   - Utils folder for static helpers - Detection and workflow generation are utilities, not core logic
 *   - scanfix organized by concern, not environment - Fixes are grouped by what they check (config, workflows, secrets)
 *
 * **When each scanfix file is used:**
 *   - config.ts: When checking/generating factiii.yml
 *   - github-cli.ts: When checking GitHub CLI installation (dev)
 *   - workflows.ts: When checking/generating GitHub workflows (dev)
 *   - secrets.ts: When checking GitHub Secrets (secrets stage)
 * ============================================================
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type {
  FactiiiConfig,
  Stage,
  Reachability,
  Fix,
  DeployResult,
  DeployOptions,
  EnvironmentConfig,
  PluginCommand,
  CommandResult,
} from '../../../types/index.js';
import { loadRelevantPlugins } from '../../index.js';
import GitHubWorkflowMonitor from '../../../utils/github-workflow-monitor.js';
import { GitHubSecretsStore } from './github-secrets-store.js';

// Import scanfix arrays
import { configFixes } from './scanfix/config.js';
import { githubCliFixes } from './scanfix/github-cli.js';
import { workflowFixes } from './scanfix/workflows.js';
import { secretsFixes } from './scanfix/secrets.js';

// Import utility methods
import * as detectionUtils from './utils/detection.js';
import * as workflowUtils from './utils/workflows.js';
import * as stagingUtils from './staging.js';
import * as prodUtils from './prod.js';

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
  // Combined from scanfix/ folder files
  // ============================================================

  static readonly fixes: Fix[] = [
    ...configFixes,
    ...githubCliFixes,
    ...workflowFixes,
    ...secretsFixes,
  ];

  // ============================================================
  // COMMANDS - Plugin commands for maintenance operations
  // ============================================================

  static readonly commands: PluginCommand[] = [
    // ────────────────────────────────────────────────────────────
    // DATABASE COMMANDS
    // ────────────────────────────────────────────────────────────
    {
      name: 'seed',
      description: 'Seed the database with initial data',
      category: 'db',
      stages: ['dev', 'staging', 'prod'],
      prodSafety: 'destructive',
      execute: async (_stage, _options, _config, rootDir): Promise<CommandResult> => {
        try {
          execSync('npx prisma db seed', { cwd: rootDir, stdio: 'inherit' });
          return { success: true, message: 'Database seeded successfully' };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    },
    {
      name: 'migrate',
      description: 'Run pending database migrations',
      category: 'db',
      stages: ['dev', 'staging', 'prod'],
      prodSafety: 'caution',
      execute: async (_stage, _options, _config, rootDir): Promise<CommandResult> => {
        try {
          execSync('npx prisma migrate deploy', { cwd: rootDir, stdio: 'inherit' });
          return { success: true, message: 'Migrations applied successfully' };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    },
    {
      name: 'reset',
      description: 'Reset database and re-run all migrations (DATA LOSS!)',
      category: 'db',
      stages: ['dev', 'staging', 'prod'],
      prodSafety: 'destructive',
      execute: async (_stage, _options, _config, rootDir): Promise<CommandResult> => {
        try {
          execSync('npx prisma migrate reset --force', { cwd: rootDir, stdio: 'inherit' });
          return { success: true, message: 'Database reset successfully' };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    },
    {
      name: 'status',
      description: 'Check migration status',
      category: 'db',
      stages: ['dev', 'staging', 'prod'],
      prodSafety: 'safe',
      execute: async (_stage, _options, _config, rootDir): Promise<CommandResult> => {
        try {
          execSync('npx prisma migrate status', { cwd: rootDir, stdio: 'inherit' });
          return { success: true };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    },

    // ────────────────────────────────────────────────────────────
    // OPS COMMANDS
    // ────────────────────────────────────────────────────────────
    {
      name: 'logs',
      description: 'View container logs',
      category: 'ops',
      stages: ['staging', 'prod'],
      prodSafety: 'safe',
      options: [
        { flags: '-f, --follow', description: 'Follow log output' },
        { flags: '-n, --lines <number>', description: 'Number of lines to show', defaultValue: '100' },
        { flags: '-s, --service <name>', description: 'Service name (default: app container)' },
      ],
      execute: async (stage, options, config, _rootDir): Promise<CommandResult> => {
        const serviceName = (options.service as string) ?? config.name + '-' + stage;
        const followFlag = options.follow ? '-f' : '';
        const lines = (options.lines as string) ?? '100';

        try {
          execSync(
            'docker logs ' + followFlag + ' --tail ' + lines + ' ' + serviceName,
            { stdio: 'inherit' }
          );
          return { success: true };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    },
    {
      name: 'restart',
      description: 'Restart application containers',
      category: 'ops',
      stages: ['staging', 'prod'],
      prodSafety: 'caution',
      options: [
        { flags: '-s, --service <name>', description: 'Service to restart (default: app container)' },
      ],
      execute: async (stage, options, config, _rootDir): Promise<CommandResult> => {
        const factiiiDir = process.env.HOME + '/.factiii';
        const serviceName = (options.service as string) ?? config.name + '-' + stage;

        try {
          execSync(
            'docker compose -f ' + factiiiDir + '/docker-compose.yml restart ' + serviceName,
            { stdio: 'inherit' }
          );
          return { success: true, message: 'Restarted ' + serviceName };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    },
    {
      name: 'shell',
      description: 'Open a shell in the application container',
      category: 'ops',
      stages: ['staging', 'prod'],
      prodSafety: 'caution',
      execute: async (stage, _options, config, _rootDir): Promise<CommandResult> => {
        const serviceName = config.name + '-' + stage;

        try {
          execSync('docker exec -it ' + serviceName + ' /bin/sh', { stdio: 'inherit' });
          return { success: true };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    },
    {
      name: 'status',
      description: 'Show container status',
      category: 'ops',
      stages: ['staging', 'prod'],
      prodSafety: 'safe',
      execute: async (_stage, _options, _config, _rootDir): Promise<CommandResult> => {
        const factiiiDir = process.env.HOME + '/.factiii';

        try {
          execSync(
            'docker compose -f ' + factiiiDir + '/docker-compose.yml ps',
            { stdio: 'inherit' }
          );
          return { success: true };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    },

    // ────────────────────────────────────────────────────────────
    // BACKUP COMMANDS
    // ────────────────────────────────────────────────────────────
    {
      name: 'create',
      description: 'Create a database backup',
      category: 'backup',
      stages: ['staging', 'prod'],
      prodSafety: 'safe',
      options: [
        { flags: '-o, --output <path>', description: 'Output file path' },
      ],
      execute: async (stage, options, _config, _rootDir): Promise<CommandResult> => {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outputPath = (options.output as string) ?? 'backup-' + stage + '-' + timestamp + '.sql';

        const dbUrl = process.env.DATABASE_URL;
        if (!dbUrl) {
          return { success: false, error: 'DATABASE_URL not set' };
        }

        try {
          execSync('pg_dump "' + dbUrl + '" > ' + outputPath, { stdio: 'inherit' });
          return { success: true, message: 'Backup created: ' + outputPath };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    },
    {
      name: 'restore',
      description: 'Restore database from backup (DATA LOSS!)',
      category: 'backup',
      stages: ['staging', 'prod'],
      prodSafety: 'destructive',
      options: [
        { flags: '-i, --input <path>', description: 'Backup file to restore' },
      ],
      execute: async (_stage, options, _config, _rootDir): Promise<CommandResult> => {
        const inputPath = options.input as string;
        if (!inputPath) {
          return { success: false, error: 'Input file required (--input)' };
        }

        const dbUrl = process.env.DATABASE_URL;
        if (!dbUrl) {
          return { success: false, error: 'DATABASE_URL not set' };
        }

        try {
          execSync('psql "' + dbUrl + '" < ' + inputPath, { stdio: 'inherit' });
          return { success: true, message: 'Database restored from ' + inputPath };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    },
    {
      name: 'health',
      description: 'Check application and database health',
      category: 'backup',
      stages: ['staging', 'prod'],
      prodSafety: 'safe',
      execute: async (stage, _options, config, rootDir): Promise<CommandResult> => {
        const results: string[] = [];

        // Check container status
        try {
          const serviceName = config.name + '-' + stage;
          execSync('docker ps | grep ' + serviceName, { stdio: 'pipe' });
          results.push('Container: Running');
        } catch {
          results.push('Container: NOT RUNNING');
        }

        // Check database connectivity
        try {
          execSync('npx prisma db execute --stdin <<< "SELECT 1"', {
            cwd: rootDir,
            stdio: 'pipe',
          });
          results.push('Database: Connected');
        } catch {
          results.push('Database: NOT CONNECTED');
        }

        console.log('\nHealth Check Results:');
        for (const r of results) {
          const icon = r.includes('NOT') ? 'X' : 'OK';
          console.log('  [' + icon + '] ' + r);
        }

        const allGood = !results.some((r) => r.includes('NOT'));
        return {
          success: allGood,
          message: allGood ? 'All systems healthy' : 'Issues detected',
        };
      },
    },
  ];

  // ============================================================
  // STATIC METHODS
  // ============================================================

  /**
   * Auto-detect pipeline configuration
   */
  static async detectConfig(rootDir: string): Promise<detectionUtils.DetectedConfig> {
    return detectionUtils.detectConfig(rootDir);
  }

  /**
   * Detect package manager
   */
  static detectPackageManager(rootDir: string): string {
    return detectionUtils.detectPackageManager(rootDir);
  }

  /**
   * Detect Node.js version from package.json
   */
  static detectNodeVersion(rootDir: string): string | null {
    return detectionUtils.detectNodeVersion(rootDir);
  }

  /**
   * Detect pnpm version from package.json
   */
  static detectPnpmVersion(rootDir: string): string | null {
    return detectionUtils.detectPnpmVersion(rootDir);
  }

  /**
   * Find Dockerfile
   */
  static findDockerfile(rootDir: string): string | null {
    return detectionUtils.findDockerfile(rootDir);
  }

  /**
   * Generate GitHub workflow files in the target repository
   */
  static async generateWorkflows(rootDir: string): Promise<void> {
    return workflowUtils.generateWorkflows(rootDir);
  }

  /**
   * Build staging Docker image (linux/arm64) on staging server
   */
  static async buildStagingImage(
    config: FactiiiConfig,
    envConfig: EnvironmentConfig
  ): Promise<DeployResult> {
    return stagingUtils.buildStagingImage(config, envConfig);
  }

  /**
   * Build production Docker image (linux/amd64) on staging server and push to ECR
   */
  static async buildProductionImage(
    config: FactiiiConfig,
    stagingConfig: EnvironmentConfig
  ): Promise<DeployResult> {
    return prodUtils.buildProductionImage(config, stagingConfig);
  }

  /**
   * Trigger a GitHub Actions workflow
   */
  static async triggerWorkflow(
    workflowName: string,
    inputs: Record<string, string> = {}
  ): Promise<void> {
    return workflowUtils.triggerWorkflow(workflowName, inputs);
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

      // Build Docker images before deployment
      // Skip if SKIP_BUILD is set (build was already done in workflow)
      if (!process.env.SKIP_BUILD) {
        const { extractEnvironments } = await import('../../../utils/config-helpers.js');
        const environments = extractEnvironments(this._config);

        if (stage === 'staging') {
          const envConfig = environments.staging;
          if (envConfig?.domain) {
            console.log('   🔨 Building staging image on staging server...');
            console.log(`   📍 Target server: ${envConfig.domain}`);
            const buildResult = await FactiiiPipeline.buildStagingImage(this._config, envConfig);
            if (!buildResult.success) {
              console.error(`   ❌ Build failed: ${buildResult.error}`);
              return buildResult;
            }
            console.log('   ✅ Staging image built successfully on staging server');
          } else {
            console.log('   ⚠️  Staging domain not configured, skipping build');
          }
        } else if (stage === 'prod') {
          const stagingConfig = environments.staging;
          if (stagingConfig?.domain) {
            console.log('   🔨 Building production image on staging server...');
            const buildResult = await FactiiiPipeline.buildProductionImage(
              this._config,
              stagingConfig
            );
            if (!buildResult.success) {
              return buildResult;
            }
          }
        }
      } else {
        console.log('   ⏭️  Skipping build step (already built in workflow)');
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
