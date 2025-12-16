const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Test SSH connection to server
 * @param {string} sshKeyPath - Path to SSH private key
 * @param {string} host - Server hostname or IP
 * @param {string} user - SSH username
 * @returns {object} - Connection result
 */
function testSSHConnection(sshKeyPath, host, user) {
  const result = {
    success: false,
    error: null
  };
  
  try {
    execSync(
      `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${user}@${host} "echo connected"`,
      { stdio: 'pipe', encoding: 'utf8' }
    );
    result.success = true;
  } catch (error) {
    result.error = `SSH connection failed: ${error.message}`;
  }
  
  return result;
}

/**
 * Discover all deployed repos on a server
 * @param {string} sshKeyPath - Path to SSH private key
 * @param {string} host - Server hostname or IP
 * @param {string} user - SSH username
 * @param {string} environment - 'staging' or 'prod'
 * @returns {object} - Discovery results
 */
function discoverDeployedRepos(sshKeyPath, host, user, environment) {
  const result = {
    repos: [],
    error: null,
    infrastructureExists: false
  };
  
  try {
    // Check if infrastructure directory exists
    const dirCheck = execSync(
      `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} "test -d ~/infrastructure && echo 'exists' || echo 'missing'"`,
      { encoding: 'utf8', stdio: 'pipe' }
    ).trim();
    
    if (dirCheck !== 'exists') {
      return result;
    }
    
    result.infrastructureExists = true;
    
    // List all config files
    const configFiles = execSync(
      `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} "ls -1 ~/infrastructure/configs/*.yml ~/infrastructure/configs/*.yaml 2>/dev/null || echo ''"`,
      { encoding: 'utf8', stdio: 'pipe' }
    ).trim();
    
    if (!configFiles) {
      return result;
    }
    
    const files = configFiles.split('\n').filter(f => f.trim());
    
    // Read each config file to get repo information
    for (const configFile of files) {
      try {
        const configContent = execSync(
          `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} "cat ${configFile}"`,
          { encoding: 'utf8', stdio: 'pipe' }
        );
        
        const config = yaml.load(configContent);
        const repoName = path.basename(configFile, path.extname(configFile));
        
        // Check if this environment exists in the config
        if (config.environments && config.environments[environment]) {
          const envConfig = config.environments[environment];
          
          result.repos.push({
            name: repoName,
            domain: envConfig.domain,
            port: envConfig.port,
            configFile: configFile
          });
        }
      } catch (error) {
        // Skip invalid config files
        continue;
      }
    }
    
  } catch (error) {
    result.error = error.message;
  }
  
  return result;
}

/**
 * Check if current repo is deployed on server
 * @param {string} sshKeyPath - Path to SSH private key
 * @param {string} host - Server hostname or IP
 * @param {string} user - SSH username
 * @param {string} repoName - Current repository name
 * @param {string} environment - 'staging' or 'prod'
 * @returns {object} - Deployment status
 */
function checkCurrentRepoDeployment(sshKeyPath, host, user, repoName, environment) {
  const result = {
    deployed: false,
    config: null,
    configFile: null,
    error: null
  };
  
  const configFile = `~/infrastructure/configs/${repoName}.yml`;
  
  try {
    // Check if config file exists
    const fileExists = execSync(
      `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} "test -f ${configFile} && echo 'exists' || echo 'missing'"`,
      { encoding: 'utf8', stdio: 'pipe' }
    ).trim();
    
    if (fileExists !== 'exists') {
      return result;
    }
    
    // Read the config
    const configContent = execSync(
      `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} "cat ${configFile}"`,
      { encoding: 'utf8', stdio: 'pipe' }
    );
    
    const config = yaml.load(configContent);
    
    if (config.environments && config.environments[environment]) {
      result.deployed = true;
      result.config = config;
      result.configFile = configFile;
    }
    
  } catch (error) {
    result.error = error.message;
  }
  
  return result;
}

/**
 * Compare current deployed config with new local config
 * @param {object} deployedConfig - Config from server
 * @param {object} localConfig - Local core.yml config
 * @param {string} environment - 'staging' or 'prod'
 * @returns {object} - Comparison results
 */
function compareConfigs(deployedConfig, localConfig, environment) {
  const changes = [];
  
  if (!deployedConfig || !localConfig) {
    return { changes, hasChanges: false };
  }
  
  const deployed = deployedConfig.environments?.[environment];
  const local = localConfig.environments?.[environment];
  
  if (!deployed || !local) {
    return { changes, hasChanges: false };
  }
  
  // Compare domain
  if (deployed.domain !== local.domain) {
    changes.push({
      field: 'domain',
      old: deployed.domain,
      new: local.domain
    });
  }
  
  // Compare port
  if (deployed.port !== local.port) {
    changes.push({
      field: 'port',
      old: deployed.port || 'auto',
      new: local.port || 'auto'
    });
  }
  
  // Compare health check
  if (deployed.health_check !== local.health_check) {
    changes.push({
      field: 'health_check',
      old: deployed.health_check,
      new: local.health_check
    });
  }
  
  return {
    changes,
    hasChanges: changes.length > 0
  };
}

/**
 * Check Docker container status
 * @param {string} sshKeyPath - Path to SSH private key
 * @param {string} host - Server hostname or IP
 * @param {string} user - SSH username
 * @param {string} serviceName - Docker service name
 * @returns {object} - Container status
 */
function checkDockerStatus(sshKeyPath, host, user, serviceName) {
  const result = {
    running: false,
    exists: false,
    error: null
  };
  
  try {
    const status = execSync(
      `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} "cd ~/infrastructure && docker compose ps -q ${serviceName} 2>/dev/null || echo ''"`,
      { encoding: 'utf8', stdio: 'pipe' }
    ).trim();
    
    if (status) {
      result.exists = true;
      
      // Check if it's running
      const runningCheck = execSync(
        `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} "cd ~/infrastructure && docker compose ps ${serviceName} 2>/dev/null | grep -i 'up' || echo ''"`,
        { encoding: 'utf8', stdio: 'pipe' }
      ).trim();
      
      result.running = !!runningCheck;
    }
  } catch (error) {
    result.error = error.message;
  }
  
  return result;
}

/**
 * Perform comprehensive server check
 * @param {object} options - Check options
 * @returns {Promise<object>} - Check results
 */
async function performServerCheck(options) {
  const {
    sshKey,
    host,
    user = 'ubuntu',
    environment,
    currentRepoName,
    localConfig
  } = options;
  
  const result = {
    environment,
    host,
    user,
    connected: false,
    infrastructureExists: false,
    allDeployedRepos: [],
    currentRepo: {
      deployed: false,
      config: null,
      comparison: null
    },
    error: null
  };
  
  // Write SSH key to temp file
  const tempDir = path.join(__dirname, '../../.temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  const sshKeyPath = path.join(tempDir, `ssh_key_${environment}_${Date.now()}`);
  
  try {
    fs.writeFileSync(sshKeyPath, sshKey, { mode: 0o600 });
    
    // Test SSH connection
    const connTest = testSSHConnection(sshKeyPath, host, user);
    if (!connTest.success) {
      result.error = connTest.error;
      return result;
    }
    
    result.connected = true;
    
    // Discover all deployed repos
    const discovery = discoverDeployedRepos(sshKeyPath, host, user, environment);
    result.infrastructureExists = discovery.infrastructureExists;
    result.allDeployedRepos = discovery.repos;
    
    // Check current repo deployment
    const currentDeploy = checkCurrentRepoDeployment(sshKeyPath, host, user, currentRepoName, environment);
    result.currentRepo.deployed = currentDeploy.deployed;
    result.currentRepo.config = currentDeploy.config;
    
    // Compare configs if deployed
    if (currentDeploy.deployed && localConfig) {
      result.currentRepo.comparison = compareConfigs(
        currentDeploy.config,
        localConfig,
        environment
      );
    }
    
  } catch (error) {
    result.error = error.message;
  } finally {
    // Clean up temp SSH key
    try {
      if (fs.existsSync(sshKeyPath)) {
        fs.unlinkSync(sshKeyPath);
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  }
  
  return result;
}

module.exports = {
  testSSHConnection,
  discoverDeployedRepos,
  checkCurrentRepoDeployment,
  compareConfigs,
  checkDockerStatus,
  performServerCheck
};




