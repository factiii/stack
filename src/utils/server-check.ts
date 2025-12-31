/**
 * Server Check Utilities
 *
 * Utilities for checking server connectivity and software.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';

import type {
  FactiiiConfig,
  EnvironmentConfig,
  SSHResult,
  ServerSoftwareChecks,
  ServerEnvironment,
  ConnectivityResult,
  RepoCheckResult,
  ConfigValidationResult,
  ServerScanResult,
  ServerBasicsResult,
  InstallDependenciesResult,
  DependencyInstallResult,
} from '../types/index.js';

/**
 * SSH to server and run a command, return output
 */
function sshCommand(
  sshKey: string,
  user: string,
  host: string,
  command: string
): SSHResult {
  try {
    const keyPath = '/tmp/factiii-check-key';
    fs.writeFileSync(keyPath, sshKey, { mode: 0o600 });

    const result = execSync(
      `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${user}@${host} "${command}"`,
      { encoding: 'utf8', stdio: 'pipe' }
    );

    fs.unlinkSync(keyPath);
    return { success: true, output: result.trim() };
  } catch (error) {
    try {
      fs.unlinkSync('/tmp/factiii-check-key');
    } catch {
      // Ignore cleanup errors
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check if server is accessible and get basic info
 */
export async function checkServerConnectivity(
  envConfig: EnvironmentConfig,
  sshKey: string
): Promise<ConnectivityResult> {
  const host = envConfig.domain;
  const ssh_user = envConfig.ssh_user ?? 'ubuntu';

  if (!host) {
    return { ssh: false, error: 'No host configured' };
  }

  if (!sshKey) {
    return { ssh: false, error: 'No SSH key available' };
  }

  const result = sshCommand(sshKey, ssh_user, host, 'echo "connected"');
  return { ssh: result.success, error: result.error };
}

/**
 * Check if required software is installed on server
 */
export async function checkServerSoftware(
  envConfig: EnvironmentConfig,
  sshKey: string
): Promise<ServerSoftwareChecks> {
  const host = envConfig.domain;
  const ssh_user = envConfig.ssh_user ?? 'ubuntu';

  const checks: ServerSoftwareChecks = {
    git: false,
    docker: false,
    dockerCompose: false,
    node: false,
  };

  // Check git
  const gitResult = sshCommand(sshKey, ssh_user, host, 'which git');
  checks.git = gitResult.success;

  // Check docker
  const dockerResult = sshCommand(sshKey, ssh_user, host, 'which docker');
  checks.docker = dockerResult.success;

  // Check docker compose
  const composeResult = sshCommand(sshKey, ssh_user, host, 'docker compose version');
  checks.dockerCompose = composeResult.success;

  // Check node
  const nodeResult = sshCommand(sshKey, ssh_user, host, 'which node');
  checks.node = nodeResult.success;

  return checks;
}

/**
 * Check if repo exists on server and get current branch
 */
export async function checkServerRepo(
  envConfig: EnvironmentConfig,
  sshKey: string,
  repoName: string
): Promise<RepoCheckResult> {
  const host = envConfig.domain;
  const ssh_user = envConfig.ssh_user ?? 'ubuntu';

  const repoPath = `~/.factiii/${repoName}`;

  // Check if directory exists
  const existsResult = sshCommand(
    sshKey,
    ssh_user,
    host,
    `test -d ${repoPath} && echo "exists"`
  );

  if (!existsResult.success || !existsResult.output?.includes('exists')) {
    return { exists: false };
  }

  // Get current branch
  const branchResult = sshCommand(
    sshKey,
    ssh_user,
    host,
    `cd ${repoPath} && git branch --show-current`
  );

  return {
    exists: true,
    branch: branchResult.success ? branchResult.output : 'unknown',
  };
}

/**
 * Validate deployed configs match source
 */
export async function validateDeployedConfigs(
  envConfig: EnvironmentConfig,
  sshKey: string,
  localConfig: FactiiiConfig
): Promise<ConfigValidationResult> {
  const host = envConfig.domain;
  const ssh_user = envConfig.ssh_user ?? 'ubuntu';

  const validation: ConfigValidationResult = {
    expectedServices: 0,
    actualServices: 0,
    nginxMatches: null,
    dockerComposeUpToDate: null,
  };

  try {
    // Count expected services from local config
    // This would need to scan all repos' configs, for now just count from current repo
    if (localConfig.environments) {
      for (const _envName of Object.keys(localConfig.environments)) {
        // Each environment creates one service per repo
        validation.expectedServices++;
      }
    }

    // Count actual running containers
    const psResult = sshCommand(
      sshKey,
      ssh_user,
      host,
      'cd ~/.factiii && docker compose ps --format json 2>/dev/null | wc -l'
    );

    if (psResult.success && psResult.output) {
      validation.actualServices = parseInt(psResult.output) || 0;
    }

    // Check if docker-compose.yml exists
    const composeExists = sshCommand(
      sshKey,
      ssh_user,
      host,
      'test -f ~/.factiii/docker-compose.yml && echo "exists"'
    );
    validation.dockerComposeUpToDate =
      composeExists.success && (composeExists.output?.includes('exists') ?? false);

    // Check nginx.conf
    const nginxExists = sshCommand(
      sshKey,
      ssh_user,
      host,
      'test -f ~/.factiii/nginx.conf && echo "exists"'
    );
    validation.nginxMatches =
      nginxExists.success && (nginxExists.output?.includes('exists') ?? false);
  } catch {
    // Validation failed, return what we have
  }

  return validation;
}

/**
 * Comprehensive server scan
 */
export async function scanServerAndValidateConfigs(
  envName: string,
  envConfig: EnvironmentConfig,
  config: FactiiiConfig,
  sshKey: string
): Promise<ServerScanResult> {
  const check: ServerScanResult = {
    environment: envName,
    ssh: false,
    git: false,
    docker: false,
    dockerCompose: false,
    node: false,
    repo: false,
    branch: null,
    repoName: config.name,
    configValidation: null,
  };

  // Check connectivity
  const connectivity = await checkServerConnectivity(envConfig, sshKey);
  check.ssh = connectivity.ssh;

  if (!check.ssh) {
    check.error = connectivity.error;
    return check;
  }

  // Check software
  const software = await checkServerSoftware(envConfig, sshKey);
  check.git = software.git;
  check.docker = software.docker;
  check.dockerCompose = software.dockerCompose;
  check.node = software.node;

  // Check repo
  const repo = await checkServerRepo(envConfig, sshKey, config.name);
  check.repo = repo.exists;
  check.branch = repo.branch ?? null;

  // Validate configs if repo exists
  if (repo.exists) {
    check.configValidation = await validateDeployedConfigs(envConfig, sshKey, config);
  }

  return check;
}

/**
 * Detect package manager and OS on server
 */
export async function detectServerEnvironment(
  envConfig: EnvironmentConfig,
  sshKey: string
): Promise<ServerEnvironment> {
  const host = envConfig.domain;
  const ssh_user = envConfig.ssh_user ?? 'ubuntu';

  const env: ServerEnvironment = {
    os: 'unknown',
    packageManager: null,
    hasHomebrew: false,
    hasApt: false,
    hasYum: false,
  };

  // Check OS
  const osResult = sshCommand(sshKey, ssh_user, host, 'uname -s');
  if (osResult.success && osResult.output) {
    const os = osResult.output.toLowerCase();
    if (os.includes('darwin')) env.os = 'macos';
    else if (os.includes('linux')) env.os = 'linux';
  }

  // Check package managers
  const brewResult = sshCommand(sshKey, ssh_user, host, 'which brew');
  env.hasHomebrew = brewResult.success;

  const aptResult = sshCommand(sshKey, ssh_user, host, 'which apt-get');
  env.hasApt = aptResult.success;

  const yumResult = sshCommand(sshKey, ssh_user, host, 'which yum');
  env.hasYum = yumResult.success;

  // Determine primary package manager
  if (env.hasHomebrew) env.packageManager = 'brew';
  else if (env.hasApt) env.packageManager = 'apt';
  else if (env.hasYum) env.packageManager = 'yum';

  return env;
}

interface InstallOptions {
  autoConfirm?: boolean;
}

/**
 * Install missing dependencies on server
 */
export async function installServerDependencies(
  envConfig: EnvironmentConfig,
  sshKey: string,
  _options: InstallOptions = {}
): Promise<InstallDependenciesResult> {
  const host = envConfig.domain;
  const ssh_user = envConfig.ssh_user ?? 'ubuntu';

  const results: {
    node: DependencyInstallResult;
    git: DependencyInstallResult;
    docker: DependencyInstallResult;
    pnpm: DependencyInstallResult;
  } = {
    node: { needed: false, installed: false, error: null },
    git: { needed: false, installed: false, error: null },
    docker: { needed: false, installed: false, error: null },
    pnpm: { needed: false, installed: false, error: null },
  };

  // Check what's missing
  const software = await checkServerSoftware(envConfig, sshKey);
  results.node.needed = !software.node;
  results.git.needed = !software.git;
  results.docker.needed = !software.docker;

  // Detect server environment
  const serverEnv = await detectServerEnvironment(envConfig, sshKey);

  if (!serverEnv.packageManager) {
    return {
      success: false,
      error: 'No supported package manager found (brew, apt, or yum)',
      results,
    };
  }

  // Install Node.js if needed
  if (results.node.needed) {
    console.log(`      📦 Installing Node.js using ${serverEnv.packageManager}...`);

    let installCmd: string;
    if (serverEnv.packageManager === 'brew') {
      installCmd = 'brew install node';
    } else if (serverEnv.packageManager === 'apt') {
      // Use NodeSource for latest Node.js on Ubuntu/Debian
      installCmd =
        'curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs';
    } else {
      installCmd =
        'curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - && sudo yum install -y nodejs';
    }

    const nodeResult = sshCommand(sshKey, ssh_user, host, installCmd);
    results.node.installed = nodeResult.success;
    results.node.error = nodeResult.error ?? null;

    if (nodeResult.success) {
      console.log('      ✅ Node.js installed successfully');
    } else {
      console.log(`      ❌ Failed to install Node.js: ${nodeResult.error}`);
    }
  }

  // Install git if needed
  if (results.git.needed) {
    console.log(`      📦 Installing git using ${serverEnv.packageManager}...`);

    let installCmd: string;
    if (serverEnv.packageManager === 'brew') {
      installCmd = 'brew install git';
    } else if (serverEnv.packageManager === 'apt') {
      installCmd = 'sudo apt-get update && sudo apt-get install -y git';
    } else {
      installCmd = 'sudo yum install -y git';
    }

    const gitResult = sshCommand(sshKey, ssh_user, host, installCmd);
    results.git.installed = gitResult.success;
    results.git.error = gitResult.error ?? null;

    if (gitResult.success) {
      console.log('      ✅ git installed successfully');
    } else {
      console.log(`      ❌ Failed to install git: ${gitResult.error}`);
    }
  }

  // Install Docker if needed (more complex, provide instructions)
  if (results.docker.needed) {
    console.log('      ⚠️  Docker not found');
    console.log('      Docker installation requires manual setup.');
    console.log(`      Please SSH to server and install Docker:`);
    console.log(`        ssh ${ssh_user}@${host}`);
    if (serverEnv.os === 'macos') {
      console.log('        brew install --cask docker');
    } else {
      console.log('        curl -fsSL https://get.docker.com | sh');
      console.log('        sudo usermod -aG docker $USER');
    }
  }

  // Install pnpm if Node.js is available
  if (software.node || results.node.installed) {
    const pnpmResult = sshCommand(sshKey, ssh_user, host, 'which pnpm');
    if (!pnpmResult.success) {
      console.log('      📦 Installing pnpm...');
      const installPnpm = sshCommand(sshKey, ssh_user, host, 'npm install -g pnpm@9');
      results.pnpm.needed = true;
      results.pnpm.installed = installPnpm.success;

      if (installPnpm.success) {
        console.log('      ✅ pnpm installed successfully');
      } else {
        console.log(`      ❌ Failed to install pnpm: ${installPnpm.error}`);
      }
    }
  }

  return {
    success: true,
    serverEnv,
    results,
  };
}

/**
 * Setup server basics (clone repo, install software if possible)
 */
export async function setupServerBasics(
  envConfig: EnvironmentConfig,
  config: FactiiiConfig,
  sshKey: string
): Promise<ServerBasicsResult> {
  const repoName = config.name;

  const result: ServerBasicsResult = {
    gitInstalled: false,
    dockerInstalled: false,
    repoCloned: false,
    repoExists: false,
    configMismatch: false,
  };

  // Check software
  const software = await checkServerSoftware(envConfig, sshKey);
  result.gitInstalled = software.git;
  result.dockerInstalled = software.docker;

  // Check if repo exists
  const repo = await checkServerRepo(envConfig, sshKey, repoName);
  result.repoExists = repo.exists;

  // Try to clone repo if it doesn't exist and git is installed
  if (!repo.exists && software.git) {
    // We can't clone without knowing the repo URL
    // This would need to be passed in or read from git config
    // For now, just report that it needs to be cloned
  }

  return result;
}

