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
import { findSshKeyForStage, sshRemoteFactiiiCommand } from '../../../utils/ssh-helper.js';

// Import scanfix arrays
import { bootstrapFixes } from './scanfix/bootstrap.js';
import { configFixes } from './scanfix/config.js';
import { githubCliFixes } from './scanfix/github-cli.js';
import { workflowFixes } from './scanfix/workflows.js';
import { secretsFixes } from './scanfix/secrets.js';
import { envFileFixes } from './scanfix/env-files.js';
import { ansibleFixes } from './scanfix/ansible.js';

// Import AWS scanfix arrays (AWS provisioning runs as part of factiii pipeline)
import { awsCliFixes } from '../aws/scanfix/aws-cli.js';
import { configFixes as awsConfigFixes } from '../aws/scanfix/config.js';
import { credentialsFixes } from '../aws/scanfix/credentials.js';
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

        // On dev machine: check for SSH key to reach server directly
        // This is the primary path - direct SSH is faster than GitHub workflows
        {
          const sshKey = findSshKeyForStage(stage);
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
            e.pipeline === 'aws' || !!e.access_key_id || !!e.config
          );
          if (hasAws) {
            return { reachable: true, via: 'local' };
          }
        }

        // No SSH key, no AWS — cannot reach this stage
        {
          const sshLabel = stage === 'staging' ? 'SSH_STAGING' : 'SSH_PROD';
          const vaultName = stage === 'staging' ? 'STAGING_SSH' : 'PROD_SSH';
          return {
            reachable: false,
            reason: sshLabel + ' not found (no key at ~/.ssh/' + stage + '_deploy_key).\n' +
              '   Run: npx stack fix --secrets   (stores key in vault + writes to disk)\n' +
              '   Or:  npx stack secrets set ' + vaultName + ' && npx stack secrets write-ssh-keys',
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
    ...bootstrapFixes,
    ...configFixes,
    ...ansibleFixes,
    ...githubCliFixes,
    ...workflowFixes,
    ...secretsFixes,
    ...envFileFixes,
    // AWS infrastructure provisioning (guarded by isAwsConfigured())
    ...awsCliFixes,
    ...awsConfigFixes,
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
    ...sshBridgeFixes,
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
      // Staging: run inside Docker container
      const containerName = config.name + '-' + stage;
      console.log('  Container: ' + containerName);

      execSync('docker exec ' + containerName + ' ' + prefix + command, {
        stdio: 'inherit',
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

      // Ensure ansible-vault is available
      try {
        execSync('ansible-vault --version', { stdio: 'pipe' });
      } catch {
        return {
          success: false,
          error: 'ansible-vault CLI not found. Install Ansible to change the vault password.',
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

      // Write new password to a temporary file for rekey
      const tmpNewPass = path.join(os.tmpdir(), `factiii-vault-pass-new-${Date.now()}`);
      fs.writeFileSync(tmpNewPass, newPassword.trim() + '\n', { encoding: 'utf8' });

      try {
        const escapedVaultPath = vaultPath.replace(/"/g, '\\"');
        const escapedOldPassFile = passwordFile.replace(/"/g, '\\"');
        const escapedNewPassFile = tmpNewPass.replace(/"/g, '\\"');

        console.log('\nRekeying vault...');
        execSync(
          `ansible-vault rekey "${escapedVaultPath}" ` +
            `--vault-password-file "${escapedOldPassFile}" ` +
            `--new-vault-password-file "${escapedNewPassFile}"`,
          {
            cwd: rootDir,
            stdio: 'inherit',
          }
        );

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
          error: 'Ansible Vault rekey failed: ' + msg,
        };
      } finally {
        try {
          if (fs.existsSync(tmpNewPass)) {
            fs.unlinkSync(tmpNewPass);
          }
        } catch {
          // ignore cleanup errors
        }
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
      description: 'Seed database with initial data via db:seed script (dev/staging only)',
      category: 'db',
      stages: ['dev', 'staging'], // No prod - destructive
      prodSafety: 'destructive',
      execute: async (stage, _options, config, rootDir): Promise<CommandResult> => {
        try {
          if (stage === 'dev') {
            // Dev: use pnpm
            FactiiiPipeline.runDbCommand('pnpm db:seed', stage, config, rootDir, false);
          } else {
            // Staging: use npm run (more commonly available in Docker)
            FactiiiPipeline.runDbCommand('npm run db:seed', stage, config, rootDir, false);
          }
          return { success: true, message: 'Database seeded successfully' };
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

    if (reach.via === 'ssh') {
      // Direct SSH to server - the primary deployment path
      console.log(`   Deploying to ${stage} via direct SSH...`);
      const sshResult = sshRemoteFactiiiCommand(stage, this._config, 'deploy --' + stage);
      return {
        success: sshResult.success,
        message: sshResult.success ? 'Deployment complete via SSH' : undefined,
        error: sshResult.success ? undefined : sshResult.stderr || 'SSH deployment failed',
      };
    }

    // via: 'local' - we can run directly (dev stage, or on-server in workflow)
    return this.runLocalDeploy(stage, options);
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
      console.log('\n[X] Cannot reach ' + stage + ': ' + reach.reason);
      return { handled: true };
    }

    if (reach.via === 'ssh') {
      console.log('   Scanning ' + stage + ' via direct SSH...');
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
    const reach = FactiiiPipeline.canReach(stage, this._config);

    if (!reach.reachable) {
      console.log('\n[X] Cannot reach ' + stage + ': ' + reach.reason);
      return { handled: true };
    }

    if (reach.via === 'ssh') {
      console.log('   Fixing ' + stage + ' via direct SSH...');
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
