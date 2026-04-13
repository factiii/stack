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
 *   - config.ts: When checking/generating stack.yml
 *   - github-cli.ts: When checking GitHub CLI installation (dev)
 *   - workflows.ts: When checking/generating GitHub workflows (dev)
 *   - secrets.ts: When checking GitHub Secrets (secrets stage)
 * ============================================================
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawnSync } from 'child_process';
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
import { findSshKeyForStage, sshRemoteFactiiiCommand } from '../../../utils/ssh-helper.js';

// Import scanfix arrays
import { preflightFixes } from './scanfix/preflight.js';
import { bootstrapFixes } from './scanfix/bootstrap.js';
import { configFixes } from './scanfix/config.js';
import { githubCliFixes } from './scanfix/github-cli.js';
import { workflowFixes } from './scanfix/workflows.js';
import { secretsFixes } from './scanfix/secrets.js';
import { envFileFixes } from './scanfix/env-files.js';
import { vaultFixes } from './scanfix/vault.js';
import { domainFixes } from './scanfix/domain.js';
import { portConventionFixes } from './scanfix/port-convention.js';
import { startShFixes } from './scanfix/start-sh.js';
import { dbSeedFixes } from './scanfix/db-seed.js';
import { sshVerifyFixes } from './scanfix/ssh-verify.js';
import { claudeSkillFixes } from './scanfix/claude-skills.js';

// Import AWS scanfix arrays (AWS provisioning runs as part of factiii pipeline)
import { configFixes as awsConfigFixes } from '../aws/scanfix/config.js';
import { credentialsFixes } from '../aws/scanfix/credentials.js';
import { dockerFixes } from '../aws/scanfix/docker.js';
import { vpcFixes } from '../aws/scanfix/vpc.js';
import { securityGroupFixes } from '../aws/scanfix/security-groups.js';
import { ec2Fixes } from '../aws/scanfix/ec2.js';
import { rdsFixes } from '../aws/scanfix/rds.js';
import { s3Fixes } from '../aws/scanfix/s3.js';
import { ecrFixes } from '../aws/scanfix/ecr.js';
import { sesFixes } from '../aws/scanfix/ses.js';
import { iamFixes } from '../aws/scanfix/iam.js';
import { dbReplicationFixes } from '../aws/scanfix/db-replication.js';
import { sshBridgeFixes } from '../aws/scanfix/ssh-bridge.js';
import { route53Fixes } from '../aws/scanfix/route53.js';

// Vercel fixes are loaded via the vercel addon plugin (not duplicated here)

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
  // GITHUB_TOKEN and ANSIBLE_VAULT_PASSWORD_FILE are infrastructure keys,
  // not app env vars — they're handled by secrets scanfixes, not .env files.
  static readonly requiredEnvVars: string[] = [];

  // Schema for stack.yml (user-editable)
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
    // Prod: pulls pre-built images from ECR, only needs stack.yml + env file
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
   *   { reachable: true, via: 'ssh' } - SSH directly to the server
   *   { reachable: false, reason: '...' } - Cannot reach, show error
   *
   * Note: 'workflow' path was removed — deploy/fix/scan workflows are gone.
   * SSH from dev machine is now the only remote execution path.
   * GitHub Actions only runs CI (build + test), not deployment.
   *
   * For the Factiii pipeline:
   *   - dev: always local
   *   - secrets: needs vault password
   *   - staging/prod:
   *       - If GITHUB_ACTIONS=true → local (we're on the server)
   *       - If SSH key exists → ssh (direct SSH from dev machine)
   *       - Otherwise → not reachable (guide user to set up SSH keys)
   *
   * CRITICAL: When SSHing to a server, the command MUST include
   *   --staging or --prod to prevent infinite loops.
   * ============================================================
   */
  static canReach(stage: Stage, config: FactiiiConfig): Reachability {
    switch (stage) {
      case 'dev':
        // Dev is always reachable locally
        return { reachable: true, via: 'local' };

      case 'secrets':
        // Need Ansible Vault configuration
        if (!config.ansible?.vault_path) {
          return {
            reachable: false,
            reason: 'ansible.vault_path not configured in stack.yml',
          };
        }

        // Check if vault password is available (file or env)
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const os = require('os');
        const vaultPasswordFile = config.ansible.vault_password_file?.replace(/^~/, os.homedir());
        const hasPasswordFile = vaultPasswordFile && fs.existsSync(vaultPasswordFile);
        const hasPasswordEnv = !!process.env.ANSIBLE_VAULT_PASSWORD || !!process.env.ANSIBLE_VAULT_PASSWORD_FILE;

        if (!hasPasswordFile && !hasPasswordEnv) {
          return {
            reachable: false,
            reason: 'Vault password required. Set ansible.vault_password_file in stack.yml, or ANSIBLE_VAULT_PASSWORD / ANSIBLE_VAULT_PASSWORD_FILE env.',
          };
        }

        return { reachable: true, via: 'local' };

      case 'staging':
      case 'prod':
        // If GITHUB_ACTIONS is set, we're running inside a workflow on the server
        // Return 'local' so fixes run directly without triggering another workflow
        if (process.env.GITHUB_ACTIONS || process.env.FACTIII_ON_SERVER) {
          return { reachable: true, via: 'local' };
        }

        // ============================================================
        // CRITICAL: Block SSH to EXAMPLE_ placeholder domains
        // ============================================================
        // If domain still has EXAMPLE_ prefix, the user hasn't configured
        // it yet. Never attempt SSH to a placeholder domain.
        // ============================================================
        {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getEnvironmentsForStage } = require('../../../utils/config-helpers.js');
          const stageEnvs = getEnvironmentsForStage(config, stage);
          const stageEnvValues = Object.values(stageEnvs) as EnvironmentConfig[];
          const allExample = stageEnvValues.every((e: EnvironmentConfig) =>
            !e.domain || e.domain.toUpperCase().startsWith('EXAMPLE')
          );
          if (allExample && stageEnvValues.length > 0) {
            // Check if AWS config exists — allow local provisioning even with EXAMPLE_ domain
            const hasAws = stageEnvValues.some((e: EnvironmentConfig) =>
              !!e.access_key_id || !!e.config
            );
            if (hasAws) {
              return { reachable: true, via: 'local' };
            }
            return {
              reachable: false,
              reason: stage + ' domain is still a placeholder (EXAMPLE_...).\n' +
                '   Replace the EXAMPLE_ value in stack.yml with your actual domain.',
            };
          }
        }

        // On dev machine: check for SSH key to reach server directly
        // This is the primary path - direct SSH is faster than GitHub workflows
        {
          const sshKey = findSshKeyForStage(stage, config.name);
          if (sshKey) {
            return { reachable: true, via: 'ssh' };
          }
        }

        // If AWS config exists, allow local provisioning (no server needed yet)
        // AWS scanfixes run on the dev machine to provision infrastructure
        {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getEnvironmentsForStage } = require('../../../utils/config-helpers.js');
          const envs = getEnvironmentsForStage(config, stage);
          const envValues = Object.values(envs) as EnvironmentConfig[];
          const hasAws = envValues.some((e: EnvironmentConfig) =>
            !!e.access_key_id || !!e.config
          );
          if (hasAws) {
            return { reachable: true, via: 'local' };
          }
        }

        // No SSH key, no AWS — cannot reach this stage
        // If vault has a key, run: npx stack fix --secrets to extract it to disk
        {
          const vaultName = stage === 'staging' ? 'STAGING_SSH' : 'PROD_SSH';
          return {
            reachable: false,
            reason: vaultName + ' not found (no key at ~/.ssh/' + stage + '_deploy_key).\n' +
              '   Run: npx stack fix --secrets   (stores key in vault + writes to disk)\n' +
              '   Or:  npx stack deploy --secrets set ' + vaultName + ' && npx stack deploy --secrets write-ssh-keys',
          };
        }

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
    ...preflightFixes,
    ...bootstrapFixes,
    ...configFixes,
    ...domainFixes,
    ...vaultFixes,
    ...githubCliFixes,
    ...workflowFixes,
    ...secretsFixes,
    ...sshVerifyFixes,
    ...envFileFixes,
    ...portConventionFixes,
    ...startShFixes,
    ...dbSeedFixes,
    ...claudeSkillFixes,
    // AWS infrastructure provisioning (guarded by isAwsConfigured())
    ...awsConfigFixes,
    ...credentialsFixes,
    ...vpcFixes,
    ...securityGroupFixes,
    ...ec2Fixes,
    ...dockerFixes,
    ...rdsFixes,
    ...s3Fixes,
    ...ecrFixes,
    ...sesFixes,
    ...iamFixes,
    ...dbReplicationFixes,
    ...sshBridgeFixes,
    ...route53Fixes,
    // Vercel fixes loaded via vercel addon plugin
  ];

  // ============================================================
  // COMMANDS - Plugin commands for maintenance operations
  // ============================================================

  /**
   * Get the env file for a stage
   * - dev: .env
   * - staging: .env.staging
   * - prod: .env.prod
   */
  static getEnvFile(stage: Stage): string {
    if (stage === 'dev') return '.env';
    return '.env.' + stage;
  }

  /**
   * Load environment variables from a file
   */
  static loadEnvFile(rootDir: string, envFile: string): Record<string, string> {
    const envPath = path.join(rootDir, envFile);
    const env: Record<string, string> = {};

    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const eqIndex = trimmed.indexOf('=');
          if (eqIndex > 0) {
            const key = trimmed.substring(0, eqIndex);
            const value = trimmed.substring(eqIndex + 1);
            env[key] = value;
          }
        }
      }
    }

    return env;
  }

  /**
   * Find the directory containing Prisma (for db commands)
   * Checks common monorepo locations
   */
  static findDbDir(rootDir: string): string {
    const locations = [
      '.',
      'apps/server',
      'packages/db',
      'packages/database',
      'server',
      'backend',
    ];

    for (const loc of locations) {
      const dir = path.join(rootDir, loc);
      // Check for prisma.config.ts or prisma/schema.prisma
      if (fs.existsSync(path.join(dir, 'prisma.config.ts')) ||
        fs.existsSync(path.join(dir, 'prisma', 'schema.prisma'))) {
        return dir;
      }
    }

    // Default to root if nothing found
    return rootDir;
  }

  /**
   * Run a database command - uses docker exec for staging/prod
   * @param command - The command to run (e.g., 'prisma migrate status' or 'pnpm db:seed')
   * @param useNpx - Whether to prefix with npx (false for pnpm commands)
   */
  static runDbCommand(
    command: string,
    stage: Stage,
    config: FactiiiConfig,
    rootDir: string,
    useNpx: boolean = true
  ): void {
    const prefix = useNpx ? 'npx ' : '';

    if (stage === 'dev') {
      // Dev: run directly on host
      const dbDir = FactiiiPipeline.findDbDir(rootDir);
      const envFile = FactiiiPipeline.getEnvFile(stage);
      const envVars = FactiiiPipeline.loadEnvFile(rootDir, envFile);

      console.log('  Directory: ' + dbDir);
      console.log('  Env file: ' + rootDir + '/' + envFile);

      execSync(prefix + command, {
        cwd: dbDir,
        stdio: 'inherit',
        env: { ...process.env, ...envVars },
      });
    } else {
      // Staging/Prod: run from repo directory on server (not inside container)
      // Container may lack node_modules; the repo has deps from pnpm install during deploy
      const dbDir = FactiiiPipeline.findDbDir(rootDir);
      const envFile = FactiiiPipeline.getEnvFile(stage);
      const envVars = FactiiiPipeline.loadEnvFile(rootDir, envFile);

      // Replace docker-internal hostname with localhost for host access
      // Handles any container hostname: postgres, factiii_postgres, db, etc.
      if (envVars.DATABASE_URL) {
        envVars.DATABASE_URL = envVars.DATABASE_URL.replace(/@([^:/@]+):(\d+)/, '@localhost:$2');
      }

      console.log('  Directory: ' + dbDir);
      console.log('  Env file: ' + rootDir + '/' + envFile);

      execSync(prefix + command, {
        cwd: dbDir,
        stdio: 'inherit',
        env: { ...process.env, ...envVars },
      });
    }
  }

  /**
   * Change the Ansible Vault password for the configured vault file.
   *
   * This runs locally on the dev machine (secrets stage) and uses:
   *   ansible-vault rekey <vault_path> --vault-password-file <old> --new-vault-password-file <new>
   *
   * It then overwrites the configured vault_password_file with the new password
   * so future commands use the updated password.
   */
  static async changeVaultPassword(config: FactiiiConfig, rootDir: string): Promise<CommandResult> {
    try {
      if (!config.ansible?.vault_path || !config.ansible.vault_password_file) {
        return {
          success: false,
          error:
            'ansible.vault_path and ansible.vault_password_file must be set in stack.yml before changing the vault password.',
        };
      }

      // Lazy-load prompts to avoid circular imports
      const { promptSingleLine } = await import('../../../utils/secret-prompts.js');

      // Resolve vault path and password file
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const os = require('os') as typeof import('os');
      const vaultPathRaw = config.ansible.vault_path.replace(/^~/, os.homedir());
      const passwordFileRaw = config.ansible.vault_password_file.replace(/^~/, os.homedir());

      const vaultPath = path.isAbsolute(vaultPathRaw)
        ? vaultPathRaw
        : path.join(rootDir, vaultPathRaw);
      const passwordFile = path.isAbsolute(passwordFileRaw)
        ? passwordFileRaw
        : path.join(rootDir, passwordFileRaw);

      if (!fs.existsSync(vaultPath)) {
        return {
          success: false,
          error: 'Vault file not found at ' + vaultPath,
        };
      }
      if (!fs.existsSync(passwordFile)) {
        return {
          success: false,
          error:
            'Vault password file not found at ' +
            passwordFile +
            '. Update ansible.vault_password_file or create the file first.',
        };
      }

      console.log('\n🔐 Change Ansible Vault password');
      console.log('   Vault file: ' + vaultPath + '\n');

      const newPassword = await promptSingleLine('   New vault password: ', { hidden: true });
      const confirmPassword = await promptSingleLine('   Confirm new password: ', { hidden: true });

      if (!newPassword || newPassword.trim().length === 0) {
        return { success: false, error: 'New password cannot be empty.' };
      }
      if (newPassword !== confirmPassword) {
        return { success: false, error: 'Passwords do not match.' };
      }

      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Vault } = require('ansible-vault') as { Vault: new (opts: { password: string }) => { encryptSync: (data: string) => string; decryptSync: (data: string) => string } };

        // Read vault content
        const vaultContent = fs.readFileSync(vaultPath, 'utf8');

        // Read old password and decrypt
        const oldPassword = fs.readFileSync(passwordFile, 'utf8').trim();
        const oldVault = new Vault({ password: oldPassword });

        console.log('\nRekeying vault...');
        let decrypted: string;
        try {
          decrypted = oldVault.decryptSync(vaultContent);
        } catch (decErr) {
          return {
            success: false,
            error: 'Failed to decrypt vault with current password: ' + (decErr instanceof Error ? decErr.message : String(decErr)),
          };
        }

        // Re-encrypt with new password
        const newVault = new Vault({ password: newPassword.trim() });
        const reEncrypted = newVault.encryptSync(decrypted);
        fs.writeFileSync(vaultPath, reEncrypted + '\n', 'utf8');

        // Overwrite the configured password file with the new password
        fs.writeFileSync(passwordFile, newPassword.trim() + '\n', {
          encoding: 'utf8',
          mode: 0o600,
        });

        console.log('\n✅ Vault password updated successfully.');
        console.log('   Updated vault file: ' + vaultPath);
        console.log('   Updated password file: ' + passwordFile + '\n');

        return { success: true, message: 'Vault password updated successfully.' };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          success: false,
          error: 'Vault rekey failed: ' + msg,
        };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    }
  }

  static readonly commands: PluginCommand[] = [
    // ────────────────────────────────────────────────────────────
    // DATABASE COMMANDS
    // ────────────────────────────────────────────────────────────
    {
      name: 'seed',
      description: 'Seed database with initial data via pnpm seed (dev/staging only)',
      category: 'db',
      stages: ['dev', 'staging'], // No prod - destructive
      prodSafety: 'destructive',
      execute: async (stage, _options, config, rootDir): Promise<CommandResult> => {
        try {
          if (stage === 'dev') {
            // Dev: run locally in apps/server
            FactiiiPipeline.runDbCommand('pnpm seed', stage, config, rootDir, false);
            return { success: true, message: 'Database seeded successfully' };
          }

          // Remote stages (staging/prod): check deployment type
          const { extractEnvironments } = await import('../../../utils/config-helpers.js');
          const environments = extractEnvironments(config);
          const envConfig = environments[stage];

          if (!envConfig) {
            return { success: false, error: stage + ' environment not configured' };
          }

          // Check if running on the server already (FACTIII_ON_SERVER or GITHUB_ACTIONS)
          if (process.env.FACTIII_ON_SERVER || process.env.GITHUB_ACTIONS) {
            // Run seed directly on host (not inside Docker) — needs access to host filesystem
            const serverDir = process.env.HOME + '/.factiii/' + config.name + '/apps/server';
            console.log('  Seeding from: ' + serverDir);
            execSync('cd ' + serverDir + ' && pnpm seed', { stdio: 'inherit' });
            return { success: true, message: 'Database seeded successfully' };
          }

          // Running from dev machine: should be routed via SSH by executePluginCommand
          // If we reach here, something went wrong with routing
          return { success: false, error: stage + ' seed requires SSH — run via: npx stack db seed --' + stage };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    },
    {
      name: 'migrate',
      description: 'Apply pending Prisma migrations to the database',
      category: 'db',
      stages: ['dev', 'staging', 'prod'],
      prodSafety: 'caution',
      execute: async (stage, _options, config, rootDir): Promise<CommandResult> => {
        try {
          FactiiiPipeline.runDbCommand('prisma migrate deploy', stage, config, rootDir);
          return { success: true, message: 'Migrations applied successfully' };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    },
    {
      name: 'reset',
      description: 'Drop all tables and re-run migrations from scratch (DATA LOSS, dev/staging only)',
      category: 'db',
      stages: ['dev', 'staging'], // No prod - destructive
      prodSafety: 'destructive',
      execute: async (stage, _options, config, rootDir): Promise<CommandResult> => {
        try {
          FactiiiPipeline.runDbCommand('prisma migrate reset --force', stage, config, rootDir);
          return { success: true, message: 'Database reset successfully' };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    },
    {
      name: 'status',
      description: 'Show pending and applied Prisma migration status',
      category: 'db',
      stages: ['dev', 'staging', 'prod'],
      prodSafety: 'safe',
      execute: async (stage, _options, config, rootDir): Promise<CommandResult> => {
        try {
          FactiiiPipeline.runDbCommand('prisma migrate status', stage, config, rootDir);
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
      description: 'Stream or tail Docker container logs',
      category: 'ops',
      stages: ['staging', 'prod'],
      prodSafety: 'safe',
      options: [
        { flags: '-f, --follow', description: 'Follow log output' },
        { flags: '-n, --lines <number>', description: 'Number of lines to show', defaultValue: '30' },
        { flags: '-s, --service <name>', description: 'Service name (default: app container)' },
        { flags: '-t, --timestamps', description: 'Show timestamps on each log line' },
        { flags: '--grep <pattern>', description: 'Filter logs by pattern' },
        { flags: '-o, --output <file>', description: 'Save logs to a file' },
        { flags: '--since <time>', description: 'Show logs since timestamp or relative (e.g. 1h, 30m, 2024-01-01)' },
      ],
      execute: async (stage, options, config, _rootDir): Promise<CommandResult> => {
        const serviceName = (options.service as string) ?? config.name + '-' + stage;
        const followFlag = options.follow ? '-f' : '';
        const lines = (options.lines as string) ?? '30';
        const timestampFlag = options.timestamps ? '--timestamps' : '';
        const sinceFlag = options.since ? '--since ' + String(options.since) : '';
        const grepPattern = options.grep ? String(options.grep) : '';
        const outputFile = options.output ? String(options.output) : '';

        const dockerCmd = 'docker logs ' + followFlag + ' ' + timestampFlag + ' ' + sinceFlag + ' --tail ' + lines + ' ' + serviceName;

        try {
          if (!grepPattern && !outputFile) {
            execSync(dockerCmd, { stdio: 'inherit' });
            return { success: true };
          }

          if (grepPattern && outputFile) {
            if (options.follow) {
              execSync(dockerCmd + ' 2>&1 | grep --line-buffered ' + JSON.stringify(grepPattern) + ' | tee ' + JSON.stringify(outputFile), { stdio: 'inherit', shell: 'bash' });
            } else {
              const result = spawnSync('bash', ['-c', dockerCmd + ' 2>&1 | grep ' + JSON.stringify(grepPattern)], { encoding: 'utf8' });
              const output = (result.stdout || '') + (result.stderr || '');
              fs.writeFileSync(outputFile, output, 'utf8');
              process.stdout.write(output);
            }
            return { success: true };
          }

          if (grepPattern) {
            if (options.follow) {
              execSync(dockerCmd + ' 2>&1 | grep --line-buffered ' + JSON.stringify(grepPattern), { stdio: 'inherit', shell: 'bash' });
            } else {
              const result = spawnSync('bash', ['-c', dockerCmd + ' 2>&1 | grep ' + JSON.stringify(grepPattern)], { encoding: 'utf8', stdio: 'pipe' });
              process.stdout.write(result.stdout || '');
            }
            return { success: true };
          }

          if (outputFile) {
            if (options.follow) {
              execSync(dockerCmd + ' 2>&1 | tee ' + JSON.stringify(outputFile), { stdio: 'inherit', shell: 'bash' });
            } else {
              const result = spawnSync('bash', ['-c', dockerCmd + ' 2>&1'], { encoding: 'utf8', stdio: 'pipe' });
              const output = result.stdout || '';
              fs.writeFileSync(outputFile, output, 'utf8');
              process.stdout.write(output);
            }
            return { success: true };
          }

          return { success: true };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    },
    {
      name: 'change-vault-password',
      description: 'Change the Ansible Vault encryption password (runs locally)',
      category: 'ops',
      stages: ['secrets'],
      prodSafety: 'safe',
      execute: async (_stage, _options, config, rootDir): Promise<CommandResult> => {
        return await FactiiiPipeline.changeVaultPassword(config, rootDir);
      },
    },
    {
      name: 'restart',
      description: 'Restart Docker containers without rebuilding',
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
      description: 'Open an interactive shell (/bin/sh) inside the app container',
      category: 'ops',
      stages: ['staging', 'prod'],
      prodSafety: 'caution',
      localOnly: true,
      execute: async (stage, _options, config, _rootDir): Promise<CommandResult> => {
        const serviceName = config.name + '-' + stage;

        // On server: run docker exec directly
        if (process.env.GITHUB_ACTIONS || process.env.FACTIII_ON_SERVER) {
          try {
            console.log('Type "exit" or press Ctrl+D to close the shell.');
            console.log('');
            execSync('docker exec -it ' + serviceName + ' /bin/sh', { stdio: 'inherit' });
            return { success: true };
          } catch (error) {
            return { success: false, error: String(error) };
          }
        }

        // On dev machine: SSH to server and run docker exec
        const { getEnvironmentsForStage } = await import('../../../utils/config-helpers.js');
        const environments = getEnvironmentsForStage(config, stage);
        const envNames = Object.keys(environments);

        if (envNames.length === 0) {
          return { success: false, error: 'No ' + stage + ' environment found in stack.yml' };
        }

        const envName = envNames[0] as string;
        const envConfig = environments[envName] as (typeof environments)[string];
        const host = envConfig.domain;
        const user = envConfig.ssh_user ?? 'ubuntu';

        if (!host) {
          return { success: false, error: 'No domain configured for ' + envName + ' in stack.yml' };
        }

        const keyPath = findSshKeyForStage(stage, config.name);
        if (!keyPath) {
          return { success: false, error: 'No SSH key found for ' + stage + '. Run: npx stack fix --secrets' };
        }

        const sshArgs = [
          '-tt',
          '-i', keyPath,
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'ServerAliveInterval=60',
          '-o', 'ServerAliveCountMax=5',
          user + '@' + host,
          'docker exec -it ' + serviceName + ' /bin/sh',
        ];

        console.log('Connecting to ' + stage + ' container (' + user + '@' + host + ')...');
        console.log('Type "exit" or press Ctrl+D to close the shell.');
        console.log('');

        const result = spawnSync('ssh', sshArgs, { stdio: 'inherit' });

        if (result.status !== 0 && result.status !== null) {
          return { success: false, error: 'SSH exited with code ' + result.status };
        }

        return { success: true };
      },
    },
    {
      name: 'ssh',
      description: 'Open an interactive SSH session to the server host',
      category: 'ops',
      stages: ['staging', 'prod'],
      prodSafety: 'caution',
      localOnly: true,
      execute: async (stage, _options, config, _rootDir): Promise<CommandResult> => {
        const { getEnvironmentsForStage } = await import('../../../utils/config-helpers.js');
        const environments = getEnvironmentsForStage(config, stage);
        const envNames = Object.keys(environments);

        if (envNames.length === 0) {
          return { success: false, error: 'No ' + stage + ' environment found in stack.yml' };
        }

        const envName = envNames[0] as string;
        const envConfig = environments[envName] as (typeof environments)[string];
        const host = envConfig.domain;
        const user = envConfig.ssh_user ?? 'ubuntu';

        if (!host) {
          return { success: false, error: 'No domain configured for ' + envName + ' in stack.yml' };
        }

        const keyPath = findSshKeyForStage(stage, config.name);
        const sshArgs: string[] = [];

        if (keyPath) {
          sshArgs.push('-i', keyPath);
        }

        sshArgs.push(
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'ServerAliveInterval=60',
          '-o', 'ServerAliveCountMax=5',
          user + '@' + host,
        );

        console.log('Connecting to ' + stage + ' (' + user + '@' + host + ')...');
        console.log('');

        const result = spawnSync('ssh', sshArgs, { stdio: 'inherit' });

        if (result.status !== 0 && result.status !== null) {
          return { success: false, error: 'SSH exited with code ' + result.status };
        }

        return { success: true };
      },
    },
    {
      name: 'status',
      description: 'Show running/stopped status of all Docker containers',
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
      description: 'Export database to a SQL dump file via pg_dump',
      category: 'backup',
      stages: ['staging', 'prod'],
      prodSafety: 'safe',
      options: [
        { flags: '-o, --output <path>', description: 'Output file path' },
      ],
      execute: async (stage, options, _config, rootDir): Promise<CommandResult> => {
        const envFile = FactiiiPipeline.getEnvFile(stage);
        const envVars = FactiiiPipeline.loadEnvFile(rootDir, envFile); // env file in root
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outputPath = (options.output as string) ?? 'backup-' + stage + '-' + timestamp + '.sql';

        console.log('  Env file: ' + rootDir + '/' + envFile);

        const dbUrl = envVars.DATABASE_URL || process.env.DATABASE_URL;

        if (!dbUrl) {
          return { success: false, error: 'DATABASE_URL not set in ' + envFile };
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
      description: 'Import a SQL dump file into the database (overwrites existing data!)',
      category: 'backup',
      stages: ['staging', 'prod'],
      prodSafety: 'destructive',
      options: [
        { flags: '-i, --input <path>', description: 'Backup file to restore' },
      ],
      execute: async (stage, options, _config, rootDir): Promise<CommandResult> => {
        const inputPath = options.input as string;
        if (!inputPath) {
          return { success: false, error: 'Input file required (--input)' };
        }

        const envFile = FactiiiPipeline.getEnvFile(stage);
        const envVars = FactiiiPipeline.loadEnvFile(rootDir, envFile); // env file in root

        console.log('  Env file: ' + rootDir + '/' + envFile);

        const dbUrl = envVars.DATABASE_URL || process.env.DATABASE_URL;

        if (!dbUrl) {
          return { success: false, error: 'DATABASE_URL not set in ' + envFile };
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
      description: 'Check if containers are running and database is reachable',
      category: 'backup',
      stages: ['staging', 'prod'],
      prodSafety: 'safe',
      execute: async (stage, _options, config, _rootDir): Promise<CommandResult> => {
        const containerName = config.name + '-' + stage;
        const results: string[] = [];

        console.log('  Container: ' + containerName);

        // Check container status
        try {
          execSync('docker ps | grep ' + containerName, { stdio: 'pipe' });
          results.push('Container: Running');
        } catch {
          results.push('Container: NOT RUNNING');
        }

        // Check database connectivity (run inside container)
        try {
          execSync(
            'docker exec ' + containerName + ' npx prisma db execute --stdin <<< "SELECT 1"',
            { stdio: 'pipe' }
          );
          results.push('Database: Connected');
        } catch {
          results.push('Database: NOT CONNECTED');
        }

        console.log('\nHealth Check Results:');
        for (const r of results) {
          const icon = r.includes('NOT') ? 'X' : 'OK';
          console.log('  [' + icon + '] ' + r);
        }

        const allGood = !results.some((r) => r.includes('NOT') || r.includes('not found'));
        return {
          success: allGood,
          message: allGood ? 'All systems healthy' : 'Issues detected',
        };
      },
    },

    // ────────────────────────────────────────────────────────────
    // OPS: API QUERY (safe — hits existing API routes)
    // ────────────────────────────────────────────────────────────
    {
      name: 'api-query',
      description: 'Query server API routes for data analysis (safe, read-only)',
      category: 'ops',
      stages: ['dev', 'staging', 'prod'],
      prodSafety: 'safe',
      localOnly: true,
      options: [
        { flags: '--url <path>', description: 'API route path (e.g., /api/health)' },
        { flags: '--method <method>', description: 'HTTP method (GET, POST)', defaultValue: 'GET' },
        { flags: '--body <json>', description: 'JSON request body for POST/PUT' },
        { flags: '--header <header...>', description: 'Additional headers (key:value)' },
      ],
      execute: async (stage, options, config, _rootDir): Promise<CommandResult> => {
        const urlPath = options.url as string;
        if (!urlPath) {
          return {
            success: false,
            error: 'API route required (--url /api/...)\n\n' +
              'Example:\n' +
              '  npx stack ops api-query --' + stage + ' --url /api/health\n' +
              '  npx stack ops api-query --' + stage + ' --url /api/users/count --method GET',
          };
        }

        const { getEnvironmentsForStage } = await import('../../../utils/config-helpers.js');
        const environments = getEnvironmentsForStage(config, stage);
        const envNames = Object.keys(environments);

        if (envNames.length === 0) {
          return { success: false, error: 'No ' + stage + ' environment found in stack.yml' };
        }

        const envName = envNames[0] as string;
        const envConfig = environments[envName] as (typeof environments)[string];
        let domain = envConfig.domain;

        if (!domain) {
          return { success: false, error: 'No domain configured for ' + envName + ' in stack.yml' };
        }

        // Dev uses localhost
        if (stage === 'dev') {
          const port = (envConfig as unknown as Record<string, unknown>).port ?? '3000';
          domain = 'http://localhost:' + port;
        } else if (!domain.startsWith('http')) {
          domain = 'https://' + domain;
        }

        const fullUrl = domain + urlPath;
        const method = ((options.method as string) ?? 'GET').toUpperCase();

        console.log('── API Query (' + stage + ') ──');
        console.log(method + ' ' + fullUrl);
        console.log('');

        try {
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          const rawHeaders = options.header as string[] | undefined;
          if (rawHeaders) {
            for (const h of rawHeaders) {
              const [key, ...rest] = h.split(':');
              if (key && rest.length > 0) headers[key.trim()] = rest.join(':').trim();
            }
          }

          const fetchOpts: RequestInit = { method, headers };
          if (options.body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
            fetchOpts.body = options.body as string;
          }

          const resp = await fetch(fullUrl, fetchOpts);
          const text = await resp.text();

          console.log('Status: ' + resp.status + ' ' + resp.statusText);
          console.log('');

          // Try pretty-print JSON, fall back to raw text
          try {
            const json = JSON.parse(text);
            console.log(JSON.stringify(json, null, 2));
          } catch {
            console.log(text);
          }

          return { success: resp.ok };
        } catch (error) {
          return { success: false, error: 'Request failed: ' + (error instanceof Error ? error.message : String(error)) };
        }
      },
    },

    // ────────────────────────────────────────────────────────────
    // OPS: DB QUERY (dangerous — direct SQL via SSH)
    // ────────────────────────────────────────────────────────────
    {
      name: 'db-query',
      description: 'Run a read-only SQL query against the database via SSH',
      category: 'ops',
      stages: ['staging', 'prod'],
      prodSafety: 'caution',
      localOnly: true,
      options: [
        { flags: '--sql <query>', description: 'SQL query to execute' },
        { flags: '--dangerous', description: 'Acknowledge direct DB access (required)' },
        { flags: '--limit <rows>', description: 'Max rows to return', defaultValue: '100' },
      ],
      execute: async (stage, options, config, _rootDir): Promise<CommandResult> => {
        const sql = options.sql as string;
        const dangerous = options.dangerous as boolean;
        const rowLimit = parseInt((options.limit as string) ?? '100', 10);

        if (!sql) {
          return { success: false, error: 'SQL query required (--sql "SELECT ...")\n\nFor safe data analysis, prefer:\n  npx stack ops api-query --' + stage + ' --url /api/...' };
        }

        if (!dangerous) {
          console.error('');
          console.error('================================================================');
          console.error('  DIRECT DATABASE ACCESS');
          console.error('================================================================');
          console.error('');
          console.error('  This command runs SQL directly against the ' + stage + ' database.');
          console.error('  You must acknowledge by adding --dangerous.');
          console.error('');
          console.error('  RULES:');
          console.error('  - READ ONLY — write queries are blocked');
          console.error('  - Avoid selecting secrets/passwords/tokens');
          console.error('  - Results are auto-limited to ' + rowLimit + ' rows');
          console.error('');
          console.error('  Example:');
          console.error('    npx stack ops db-query --' + stage + ' --dangerous --sql "SELECT id, email FROM users LIMIT 10"');
          console.error('');
          console.error('  For safe analysis, prefer API routes:');
          console.error('    npx stack ops api-query --' + stage + ' --url /api/...');
          console.error('');
          console.error('================================================================');
          return { success: false, error: 'Add --dangerous to acknowledge direct DB access' };
        }

        // === BLOCK DESTRUCTIVE SQL ===
        const upperSql = sql.toUpperCase().replace(/\s+/g, ' ').trim();
        const destructivePatterns = [
          /\bINSERT\b/, /\bUPDATE\b/, /\bDELETE\b/,
          /\bDROP\b/, /\bALTER\b/, /\bTRUNCATE\b/,
          /\bCREATE\b/, /\bGRANT\b/, /\bREVOKE\b/,
          /\bEXEC\b/, /\bCALL\b/,
        ];

        const isDestructive = destructivePatterns.some(p => p.test(upperSql));
        if (isDestructive) {
          console.error('');
          console.error('================================================================');
          console.error('  BLOCKED: DESTRUCTIVE SQL QUERY');
          console.error('================================================================');
          console.error('');
          console.error('  The query contains write/modify operations.');
          console.error('  db-query is READ ONLY — no INSERT, UPDATE, DELETE, DROP,');
          console.error('  ALTER, TRUNCATE, CREATE, GRANT, REVOKE, EXEC, or CALL.');
          console.error('');
          console.error('================================================================');
          return { success: false, error: 'Destructive queries are blocked in db-query' };
        }

        // === WARN ON SENSITIVE COLUMNS ===
        const sensitivePattern = /\b(password|secret|token|api_key|private_key|credential|ssn|credit_card|hash)\b/i;
        if (sensitivePattern.test(sql) && !/\bCOUNT\b/i.test(sql)) {
          console.warn('');
          console.warn('WARNING: Query may touch sensitive columns (password/secret/token/key).');
          console.warn('Consider selecting only the columns you need.');
          console.warn('');
        }

        // === AUTO-APPEND LIMIT ===
        let finalSql = sql.trim().replace(/;$/, '');
        if (!/\bLIMIT\b/i.test(finalSql)) {
          finalSql = finalSql + ' LIMIT ' + rowLimit;
        }

        // === RESOLVE SSH TARGET ===
        const { getEnvironmentsForStage } = await import('../../../utils/config-helpers.js');
        const environments = getEnvironmentsForStage(config, stage);
        const envNames = Object.keys(environments);

        if (envNames.length === 0) {
          return { success: false, error: 'No ' + stage + ' environment found in stack.yml' };
        }

        const envName = envNames[0] as string;
        const envConfig = environments[envName] as (typeof environments)[string];
        const host = envConfig.domain;
        const user = envConfig.ssh_user ?? 'ubuntu';

        if (!host) {
          return { success: false, error: 'No domain configured for ' + envName + ' in stack.yml' };
        }

        const keyPath = findSshKeyForStage(stage, config.name);
        if (!keyPath) {
          return { success: false, error: 'No SSH key found for ' + stage + '. Run: npx stack fix --secrets' };
        }

        const containerName = config.name + '-' + stage;
        // Escape single quotes for shell
        const escapedSql = finalSql.replace(/'/g, "'\\''");

        console.log('');
        console.log('── DB Query (' + stage + ') ──');
        console.log('READ ONLY — destructive queries are blocked');
        console.log('Container: ' + containerName);
        console.log('');
        console.log('SQL: ' + finalSql);
        console.log('');

        const dockerCmd = 'docker exec ' + containerName + ' sh -c \'psql "$DATABASE_URL" -c "' + escapedSql.replace(/"/g, '\\"') + '"\'';

        const sshArgs = [
          '-i', keyPath,
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'ConnectTimeout=10',
          user + '@' + host,
          dockerCmd,
        ];

        const result = spawnSync('ssh', sshArgs, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

        if (result.stdout) {
          console.log(result.stdout);
        }
        if (result.stderr) {
          // psql outputs notices to stderr — show them but don't fail on them
          const stderr = result.stderr.trim();
          if (stderr) console.error(stderr);
        }

        if (result.status !== 0 && result.status !== null) {
          return { success: false, error: 'Query failed (exit code ' + result.status + ')' };
        }

        return { success: true };
      },
    },

    // ────────────────────────────────────────────────────────────
    // AWS COMMANDS
    // ────────────────────────────────────────────────────────────
    {
      name: 'aws',
      description: 'Run an AWS CLI command with stage-appropriate credentials',
      category: 'aws',
      stages: ['staging', 'prod'],
      prodSafety: 'caution',
      localOnly: true,
      execute: async (stage, options, config, _rootDir): Promise<CommandResult> => {
        const awsCmd = ((options.cmd as string) ?? '').trim();
        if (!awsCmd) {
          return {
            success: false,
            error: 'AWS command required\n\n' +
              'Examples:\n' +
              '  npx stack aws --' + stage + ' "s3 ls"\n' +
              '  npx stack aws --' + stage + ' "ec2 describe-instances"\n' +
              '  npx stack aws --' + stage + ' "rds describe-db-instances"',
          };
        }

        // Resolve AWS credentials from vault via the credentials file
        // The aws scanfix/credentials.ts writes ~/.aws/credentials from vault
        // We rely on that being synced — check if credentials exist
        const awsCredPath = (process.env.HOME ?? '') + '/.aws/credentials';
        let hasCredentials = false;
        try {
          const content = fs.readFileSync(awsCredPath, 'utf8');
          hasCredentials = /aws_access_key_id\s*=\s*\S+/.test(content);
        } catch {
          // no credentials file
        }

        if (!hasCredentials) {
          // Try to sync credentials from vault
          console.log('AWS credentials not found locally. Run scan to sync from vault:');
          console.log('  npx stack scan --' + stage);
          console.log('');
          return { success: false, error: 'AWS credentials not available. Run npx stack scan --' + stage + ' first to sync from vault.' };
        }

        // Get region from config
        const { getAwsConfig } = await import('../aws/utils/aws-helpers.js');
        const awsConfig = getAwsConfig(config);
        const region = awsConfig.region;

        console.log('── AWS CLI (' + stage + ') ──');
        console.log('Region: ' + region);
        console.log('Command: aws ' + awsCmd);
        console.log('');

        // Split the command string into args for spawn
        const args = awsCmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
        // Strip quotes from args
        const cleanArgs = args.map(a => a.replace(/^["']|["']$/g, ''));

        // Add --region if not already specified and not a global command
        if (!cleanArgs.includes('--region')) {
          cleanArgs.push('--region', region);
        }

        const result = spawnSync('aws', cleanArgs, {
          stdio: 'inherit',
          env: { ...process.env, AWS_DEFAULT_REGION: region },
        });

        if (result.status !== 0 && result.status !== null) {
          return { success: false, error: 'AWS command exited with code ' + result.status };
        }

        return { success: true };
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
   * Build production Docker image locally on the prod server itself and push to ECR.
   * Used when deploying directly on the prod server (FACTIII_ON_SERVER=true).
   */
  static async buildProductionImageLocally(
    config: FactiiiConfig
  ): Promise<DeployResult> {
    return prodUtils.buildProductionImageLocally(config);
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

    if (reach.via === 'ssh') {
      // For prod with AWS config: build locally on dev machine, then SSH only for pull+restart
      // This avoids building Docker on resource-constrained prod servers (e.g., t3.micro 1GB RAM)
      if (stage === 'prod' && this._config.aws) {
        console.log(`   Deploying to ${stage} via local build + SSH pull...`);

        // Step 1: Build Docker image locally and push to ECR (on dev machine)
        if (!process.env.SKIP_BUILD) {
          const { extractEnvironments } = await import('../../../utils/config-helpers.js');
          const environments = extractEnvironments(this._config);
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
          } else {
            // No staging server — build locally on dev machine
            console.log('   🔨 Building production image locally...');
            const buildResult = await FactiiiPipeline.buildProductionImageLocally(this._config);
            if (!buildResult.success) {
              return buildResult;
            }
          }
        } else {
          console.log('   ⏭️  Skipping build step (SKIP_BUILD is set)');
        }

        // Step 2: SSH to prod server only for pull + restart (deployProd handles this)
        const { deployProd } = await import('../aws/prod.js');
        return deployProd(this._config, stage);
      }

      // For non-prod or non-AWS: use the original SSH remote command flow
      console.log(`   Deploying to ${stage} via direct SSH...`);
      let sshCommand = 'deploy --' + stage;
      if (options.branch) sshCommand += ' --branch ' + options.branch;
      if (options.commit) sshCommand += ' --commit ' + options.commit;
      const sshResult = await sshRemoteFactiiiCommand(stage, this._config, sshCommand);
      return {
        success: sshResult.success,
        message: sshResult.success ? 'Deployment complete via SSH' : undefined,
        error: sshResult.success ? undefined : sshResult.stderr || 'SSH deployment failed',
      };
    }

    // via: 'local' - we can run directly (dev stage, or on-server in workflow)
    const localResult = await this.runLocalDeploy(stage, options);

    // Also deploy to Vercel if configured (addon triggered by pipeline)
    if (this._config.vercel && localResult.success && (stage === 'staging' || stage === 'prod')) {
      try {
        const { default: VercelAddon } = await import('../../addons/vercel/index.js');
        if (VercelAddon.isVercelConfigured(this._config)) {
          console.log('');
          console.log('   ── Vercel Deployment ──');
          const vercelResult = await VercelAddon.deployToVercel(this._config, {
            production: stage === 'prod',
          });
          if (vercelResult.success) {
            console.log('   [OK] ' + (vercelResult.message ?? 'Vercel deployment complete'));
          } else {
            console.log('   [!] Vercel deployment failed: ' + (vercelResult.error ?? 'unknown'));
          }
        }
      } catch { /* Vercel addon not available, skip */ }
    }

    return localResult;
  }

  /**
   * Scan a stage - handles routing based on canReach()
   *
   * Returns { handled: true } if pipeline ran scan remotely.
   * Returns { handled: false } if caller should run scan locally.
   */
  async scanStage(stage: Stage, _options: Record<string, unknown> = {}): Promise<{ handled: boolean }> {
    const reach = FactiiiPipeline.canReach(stage, this._config);

    if (!reach.reachable) {
      return { handled: true };
    }

    if (reach.via === 'ssh') {
      // Get domain for display
      const { getEnvironmentsForStage } = await import('../../../utils/config-helpers.js');
      const envs = getEnvironmentsForStage(this._config, stage);
      const envValues = Object.values(envs) as { domain?: string }[];
      const domain = envValues[0]?.domain || 'unknown';

      console.log('');
      console.log('┌─ ' + stage.toUpperCase() + ' (via SSH → ' + domain + ')');
      const sshResult = await sshRemoteFactiiiCommand(stage, this._config, 'scan --' + stage);
      console.log('└─');

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
  async fixStage(stage: Stage, _options: Record<string, unknown> = {}): Promise<{ handled: boolean; success?: boolean; error?: string }> {
    const reach = FactiiiPipeline.canReach(stage, this._config);

    if (!reach.reachable) {
      return { handled: true, success: false, error: reach.reason };
    }

    if (reach.via === 'ssh') {
      // Get domain for display
      const { getEnvironmentsForStage } = await import('../../../utils/config-helpers.js');
      const envs = getEnvironmentsForStage(this._config, stage);
      const envValues = Object.values(envs) as { domain?: string; ssh_user?: string }[];
      const domain = envValues[0]?.domain || 'unknown';

      console.log('');
      console.log('┌─ ' + stage.toUpperCase() + ' (via SSH → ' + domain + ')');
      const sshResult = await sshRemoteFactiiiCommand(stage, this._config, 'fix --' + stage);
      console.log('└─');

      // The remote fix already printed its own summary inline.
      // Don't double-report: just mark as handled. The user already saw
      // the server's detailed output (manual fixes, errors, etc.).
      return { handled: true, success: sshResult.success };
    }

    // via: 'local' - caller should run locally
    return { handled: false };
  }

  /**
   * Run deployment locally by delegating to server plugin
   */
  private async runLocalDeploy(stage: Stage, options: DeployOptions): Promise<DeployResult> {
    const rootDir = options.rootDir ?? process.cwd();

    // Load plugins and find the correct server plugin for this stage
    const plugins = await loadRelevantPlugins(rootDir, this._config);

    // Match server plugin to the environment's server type (e.g., 'ubuntu', 'mac')
    const { extractEnvironments } = await import('../../../utils/config-helpers.js');
    const environments = extractEnvironments(this._config);
    const envConfig = environments[stage];
    const serverType = envConfig?.server;

    const ServerPluginClass = (serverType
      ? plugins.find((p) => p.category === 'server' && (p as { id?: string }).id === serverType)
      : plugins.find((p) => p.category === 'server')
    ) as {
      new(config: FactiiiConfig): {
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

        // Reload config after checkout — the branch may have a different stack.yml
        const { loadConfig } = await import('../../../utils/config-helpers.js');
        const rootDir = options.rootDir ?? process.cwd();
        this._config = loadConfig(rootDir);
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
          } else {
            // No staging server — build locally on prod server as fallback
            console.log('   🔨 No staging server configured — building on prod server...');
            const buildResult = await FactiiiPipeline.buildProductionImageLocally(this._config);
            if (!buildResult.success) {
              return buildResult;
            }
          }
        }
      } else {
        console.log('   ⏭️  Skipping build step (already built in workflow)');
      }

      // Run the actual deployment
      // For prod with AWS config: use AWS prod deployment (pull from ECR, certbot, docker compose up)
      if (stage === 'prod' && this._config.aws) {
        const { deployProd } = await import('../aws/prod.js');
        return deployProd(this._config, stage);
      }
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
