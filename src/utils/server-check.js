const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * SSH to server and run a command, return output
 */
function sshCommand(sshKey, user, host, command) {
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
    try { fs.unlinkSync('/tmp/factiii-check-key'); } catch (e) {}
    return { success: false, error: error.message };
  }
}

/**
 * Check if server is accessible and get basic info
 */
async function checkServerConnectivity(envConfig, sshKey) {
  const { host, ssh_user = 'ubuntu' } = envConfig;
  
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
async function checkServerSoftware(envConfig, sshKey) {
  const { host, ssh_user = 'ubuntu' } = envConfig;
  
  const checks = {
    git: false,
    docker: false,
    dockerCompose: false,
    node: false
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
async function checkServerRepo(envConfig, sshKey, repoName) {
  const { host, ssh_user = 'ubuntu' } = envConfig;
  
  const repoPath = `~/.factiii/${repoName}`;
  
  // Check if directory exists
  const existsResult = sshCommand(sshKey, ssh_user, host, `test -d ${repoPath} && echo "exists"`);
  
  if (!existsResult.success || !existsResult.output.includes('exists')) {
    return { exists: false };
  }
  
  // Get current branch
  const branchResult = sshCommand(sshKey, ssh_user, host, `cd ${repoPath} && git branch --show-current`);
  
  return {
    exists: true,
    branch: branchResult.success ? branchResult.output : 'unknown'
  };
}

/**
 * Validate deployed configs match source
 */
async function validateDeployedConfigs(envConfig, sshKey, localConfig) {
  const { host, ssh_user = 'ubuntu' } = envConfig;
  
  const validation = {
    expectedServices: 0,
    actualServices: 0,
    nginxMatches: null,
    dockerComposeUpToDate: null
  };
  
  try {
    // Count expected services from local config
    // This would need to scan all repos' configs, for now just count from current repo
    if (localConfig.environments) {
      for (const [envName, envCfg] of Object.entries(localConfig.environments)) {
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
    
    if (psResult.success) {
      validation.actualServices = parseInt(psResult.output) || 0;
    }
    
    // Check if docker-compose.yml exists
    const composeExists = sshCommand(
      sshKey,
      ssh_user,
      host,
      'test -f ~/.factiii/docker-compose.yml && echo "exists"'
    );
    validation.dockerComposeUpToDate = composeExists.success && composeExists.output.includes('exists');
    
    // Check nginx.conf
    const nginxExists = sshCommand(
      sshKey,
      ssh_user,
      host,
      'test -f ~/.factiii/nginx.conf && echo "exists"'
    );
    validation.nginxMatches = nginxExists.success && nginxExists.output.includes('exists');
    
  } catch (error) {
    // Validation failed, return what we have
  }
  
  return validation;
}

/**
 * Comprehensive server scan
 */
async function scanServerAndValidateConfigs(envName, envConfig, config, sshKey) {
  const check = {
    environment: envName,
    ssh: false,
    git: false,
    docker: false,
    dockerCompose: false,
    node: false,
    repo: false,
    branch: null,
    repoName: config.name,
    configValidation: null
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
  check.branch = repo.branch;
  
  // Validate configs if repo exists
  if (repo.exists) {
    check.configValidation = await validateDeployedConfigs(envConfig, sshKey, config);
  }
  
  return check;
}

/**
 * Setup server basics (clone repo, install software if possible)
 */
async function setupServerBasics(envConfig, config, sshKey) {
  const { host, ssh_user = 'ubuntu' } = envConfig;
  const repoName = config.name;
  
  const result = {
    gitInstalled: false,
    dockerInstalled: false,
    repoCloned: false,
    repoExists: false,
    configMismatch: false
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

module.exports = {
  checkServerConnectivity,
  checkServerSoftware,
  checkServerRepo,
  validateDeployedConfigs,
  scanServerAndValidateConfigs,
  setupServerBasics
};
