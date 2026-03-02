/**
 * SSH Helper Utility
 *
 * Shared SSH execution logic for pipeline and server plugins.
 * Provides a consistent way to execute commands on remote servers.
 *
 * Auth priority:
 * 1. SSH key: ~/.ssh/{stage}_deploy_key (from Ansible Vault via write-ssh-keys)
 * 2. Password: {STAGE}_SSH_PASSWORD from Ansible Vault (uses sshpass)
 */
import { execSync, spawnSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import yaml from 'js-yaml';
import type { EnvironmentConfig, FactiiiConfig, Stage } from '../types/index.js';
import { extractEnvironments, getStageFromEnvironment } from './config-helpers.js';
import { promptSingleLine } from './secret-prompts.js';
import { AnsibleVaultSecrets } from './ansible-vault-secrets.js';

/**
 * Map of stage names to their environment-specific SSH key filenames.
 * These keys are extracted from Ansible Vault by `npx stack deploy --secrets write-ssh-keys`.
 */
const STAGE_KEY_MAP: Record<string, string[]> = {
  staging: ['staging_deploy_key'],
  prod: ['prod_deploy_key'],
  mac: ['mac_deploy_key'],
};

/**
 * Find the SSH key path for a given stage.
 * Only returns stage-specific deploy keys — no generic key fallback.
 *
 * @param stage - The deployment stage (staging, prod, mac)
 * @returns Absolute path to SSH key, or null if none found
 */
export function findSshKeyForStage(stage: string): string | null {
  const sshDir = path.join(os.homedir(), '.ssh');

  const stageKeys = STAGE_KEY_MAP[stage] ?? [];
  for (const keyName of stageKeys) {
    const keyPath = path.join(sshDir, keyName);
    if (fs.existsSync(keyPath)) {
      return keyPath;
    }
  }

  return null;
}

/**
 * Get the EnvironmentConfig for a given stage from stack.yml config.
 * Returns the first environment matching the stage.
 *
 * @param stage - The deployment stage (staging, prod)
 * @param config - Parsed stack.yml config
 * @returns EnvironmentConfig with domain and ssh_user, or null
 */
export function getEnvConfigForStage(
  stage: Stage,
  config: FactiiiConfig
): EnvironmentConfig | null {
  const environments = extractEnvironments(config);

  for (const [envName, envConfig] of Object.entries(environments)) {
    try {
      if (getStageFromEnvironment(envName) === stage) {
        return envConfig;
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Look up {STAGE}_SSH_PASSWORD from Ansible Vault.
 * Returns null if vault not configured or password not stored.
 */
function getSshPasswordFromVault(stage: string, config: FactiiiConfig, rootDir?: string): string | null {
  if (!config.ansible?.vault_path) return null;

  try {
    const secretName = stage.toUpperCase() + '_SSH_PASSWORD';
    const vaultPath = config.ansible.vault_path;
    const resolvedPath = path.isAbsolute(vaultPath)
      ? vaultPath
      : path.join(rootDir ?? process.cwd(), vaultPath);

    if (!fs.existsSync(resolvedPath)) return null;

    // Build ansible-vault view command
    let cmd = 'ansible-vault view "' + resolvedPath + '"';
    if (config.ansible.vault_password_file) {
      const pwFile = config.ansible.vault_password_file.replace(/^~/, os.homedir());
      cmd += ' --vault-password-file "' + pwFile + '"';
    }

    const content = execSync(cmd, { encoding: 'utf8', stdio: 'pipe' });
    const parsed = yaml.load(content) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed[secretName];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Prompt user for SSH password, test it, and store in Ansible Vault if valid.
 * Returns the password on success, null on failure.
 */
async function promptAndValidatePassword(
  stage: string,
  host: string,
  user: string,
  config: FactiiiConfig,
  rootDir?: string
): Promise<string | null> {
  // Vault must be configured to store the password
  if (!config.ansible?.vault_path) {
    console.log('   [!] Cannot prompt for password — ansible.vault_path not configured');
    return null;
  }

  console.log('');
  console.log('   No SSH key or stored password for ' + stage + '.');

  const password = await promptSingleLine('   Enter SSH password for ' + user + '@' + host + ': ', { hidden: true });
  if (!password) {
    console.log('   [!] No password entered');
    return null;
  }

  // Test the connection with a quick command
  console.log('   Testing SSH connection...');
  const testResult = spawnSync('sshpass', [
    '-p', password,
    'ssh',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=5',
    user + '@' + host,
    'echo ok',
  ], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 15000,
  });

  if (testResult.status !== 0) {
    console.log('   [!] SSH authentication failed. Check your password and try again.');
    return null;
  }

  // Password works — store in Ansible Vault
  const secretName = stage.toUpperCase() + '_SSH_PASSWORD';
  try {
    const store = new AnsibleVaultSecrets({
      vault_path: config.ansible.vault_path,
      vault_password_file: config.ansible.vault_password_file,
      rootDir: rootDir ?? process.cwd(),
    });

    const result = await store.setSecret(secretName, password);
    if (result.success) {
      console.log('   [OK] Password stored in Ansible Vault as ' + secretName);
      console.log('        Next time, it will be used automatically.');
    } else {
      console.log('   [!] Password works but failed to store in vault: ' + (result.error ?? 'unknown error'));
      console.log('        You will be prompted again next time.');
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log('   [!] Password works but failed to store in vault: ' + msg);
  }

  return password;
}

/**
 * Execute a Factiii CLI command on a remote server via direct SSH.
 * Used by scan.ts, fix.ts, and deployStage() when canReach returns via: 'ssh'.
 *
 * Auth priority:
 * 1. SSH key file (~/.ssh/{stage}_deploy_key)
 * 2. Password from vault ({STAGE}_SSH_PASSWORD) via sshpass
 *
 * @param stage - Target stage (staging, prod)
 * @param config - Parsed stack.yml config
 * @param command - The factiii CLI command to run (e.g., 'scan --staging', 'fix --prod')
 * @param rootDir - Optional project root directory (for vault path resolution)
 * @returns Object with success, stdout, and stderr
 */
export async function sshRemoteFactiiiCommand(
  stage: Stage,
  config: FactiiiConfig,
  command: string,
  rootDir?: string
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const envConfig = getEnvConfigForStage(stage, config);
  if (!envConfig) {
    return {
      success: false,
      stdout: '',
      stderr: 'No environment config found for stage: ' + stage,
    };
  }

  const host = envConfig.domain;
  const user = envConfig.ssh_user ?? 'root';

  if (!host) {
    return {
      success: false,
      stdout: '',
      stderr: 'No domain configured for stage: ' + stage + '. Check stack.yml environments.',
    };
  }

  const keyPath = findSshKeyForStage(stage);

  // If no SSH key, try password from vault, then prompt user
  if (!keyPath) {
    let password = getSshPasswordFromVault(stage, config, rootDir);

    // No stored password — prompt user, validate, and store
    if (!password) {
      password = await promptAndValidatePassword(stage, host, user, config, rootDir);
    }

    if (!password) {
      return {
        success: false,
        stdout: '',
        stderr: 'No SSH key at ' + path.join(os.homedir(), '.ssh', stage + '_deploy_key') +
          ' and no ' + stage.toUpperCase() + '_SSH_PASSWORD in vault.',
      };
    }

    // Use sshpass with password from vault
    const repoName = config.name || 'app';
    const remoteCommand = 'export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH" && export FACTIII_ON_SERVER=true && cd $HOME/.factiii/' + repoName + ' && npx stack ' + command;

    console.log('   SSH (password): ' + user + '@' + host + ' → npx stack ' + command);
    console.log('   Connecting to ' + host + '... (timeout: 10min)');

    const startTime = Date.now();

    const result = spawnSync('sshpass', [
      '-p', password,
      'ssh',
      '-tt',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=60',
      '-o', 'ServerAliveCountMax=5',
      user + '@' + host,
      remoteCommand,
    ], {
      encoding: 'utf8',
      stdio: 'inherit',
      timeout: 600000,
    });

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    console.log('   SSH completed in ' + elapsed + 's');

    return {
      success: result.status === 0,
      stdout: '',
      stderr: result.status !== 0 ? 'SSH command exited with code ' + result.status : '',
    };
  }

  // Build the remote command
  // Run inside the factiii repo directory on the server
  // $HOME is expanded by the remote shell, supporting non-root users
  const repoName = config.name || 'app';
  const remoteCommand = 'export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH" && export FACTIII_ON_SERVER=true && cd $HOME/.factiii/' + repoName + ' && npx stack ' + command;

  console.log('   SSH: ' + user + '@' + host + ' → npx stack ' + command);
  console.log('   Connecting to ' + host + '... (timeout: 10min)');

  const startTime = Date.now();

  const result = spawnSync('ssh', [
    '-tt',  // Force TTY allocation so sudo prompts work over SSH
    '-i', keyPath,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=60',
    '-o', 'ServerAliveCountMax=5',
    user + '@' + host,
    remoteCommand,
  ], {
    encoding: 'utf8',
    stdio: 'inherit',  // Pass through stdin/stdout/stderr for interactive sudo
    timeout: 600000, // 10 minute timeout for long-running operations
  });

  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  console.log('   SSH completed in ' + elapsed + 's');

  // With stdio: 'inherit', output is streamed directly to terminal.
  // stdout/stderr are null in the result, so we return empty strings.
  return {
    success: result.status === 0,
    stdout: '',
    stderr: result.status !== 0 ? 'SSH command exited with code ' + result.status : '',
  };
}

/**
 * Execute a command on a remote server via SSH
 * Falls back to sshpass with vault password when no SSH key exists.
 *
 * @param envConfig - Environment config with host and ssh_user
 * @param command - Command to execute
 * @param stage - Optional stage to use the correct SSH key (staging, prod)
 * @param config - Optional stack.yml config (needed for vault password fallback)
 * @param rootDir - Optional project root directory (for vault path resolution)
 * @returns Command output
 */
export async function sshExec(
  envConfig: EnvironmentConfig,
  command: string,
  stage?: Stage,
  config?: FactiiiConfig,
  rootDir?: string
): Promise<string> {
  // ============================================================
  // CRITICAL: Detect if we're already on the server
  // ============================================================
  // When GITHUB_ACTIONS=true or FACTIII_ON_SERVER=true, we're executing
  // on the server itself. Run commands locally instead of trying to SSH.
  // ============================================================
  if (process.env.GITHUB_ACTIONS === 'true' || process.env.FACTIII_ON_SERVER === 'true') {
    // We're already on the server - run command locally
    const result = execSync(command, { encoding: 'utf8', stdio: 'pipe' });
    return result.trim();
  }

  // Running from dev machine - SSH to server
  const host = envConfig.domain;
  const user = envConfig.ssh_user ?? 'ubuntu';

  // Use stage-specific key if stage is provided
  let keyPath: string | null = null;
  if (stage) {
    keyPath = findSshKeyForStage(stage);
  }

  // Fallback: try all known deploy keys
  if (!keyPath) {
    const keyPaths = [
      path.join(os.homedir(), '.ssh', 'staging_deploy_key'),
      path.join(os.homedir(), '.ssh', 'prod_deploy_key'),
      path.join(os.homedir(), '.ssh', 'mac_deploy_key'),
    ];

    for (const kp of keyPaths) {
      if (fs.existsSync(kp)) {
        keyPath = kp;
        break;
      }
    }
  }

  // No SSH key — try password from vault, then prompt user
  if (!keyPath) {
    let password: string | null = null;

    if (config && stage) {
      password = getSshPasswordFromVault(stage, config, rootDir);

      // No stored password — prompt user, validate, and store
      if (!password) {
        password = await promptAndValidatePassword(stage, host as string, user, config, rootDir);
      }
    }

    if (password) {
      const result = spawnSync('sshpass', [
        '-p', password,
        'ssh',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=60',
        '-o', 'ServerAliveCountMax=5',
        user + '@' + host,
        command,
      ], {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      if (result.status !== 0) {
        throw new Error(result.stderr || 'SSH (password) command failed with exit code ' + result.status);
      }

      return (result.stdout ?? '').trim();
    }

    throw new Error(
      'No SSH key found. Add a deploy key to ~/.ssh/ or store password: npx stack fix --secrets'
    );
  }

  const result = spawnSync('ssh', [
    '-i', keyPath,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=60',
    '-o', 'ServerAliveCountMax=5',
    user + '@' + host,
    command,
  ], {
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || 'SSH command failed with exit code ' + result.status);
  }

  return (result.stdout ?? '').trim();
}
