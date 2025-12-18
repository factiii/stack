/**
 * SSH Helper Utility
 * 
 * Shared SSH execution logic for pipeline and server plugins.
 * Provides a consistent way to execute commands on remote servers.
 */
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

/**
 * Execute a command on a remote server via SSH
 * @param {Object} envConfig - Environment config with host and ssh_user
 * @param {string} command - Command to execute
 * @returns {Promise<string>} Command output
 */
async function sshExec(envConfig, command) {
  const host = envConfig.host;
  const user = envConfig.ssh_user || 'ubuntu';
  
  // Try to find SSH key
  const keyPaths = [
    path.join(os.homedir(), '.ssh', 'id_ed25519'),
    path.join(os.homedir(), '.ssh', 'id_rsa')
  ];
  
  let keyPath = null;
  for (const kp of keyPaths) {
    if (fs.existsSync(kp)) {
      keyPath = kp;
      break;
    }
  }
  
  if (!keyPath) {
    throw new Error('No SSH key found');
  }
  
  const result = execSync(
    `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${user}@${host} "${command.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', stdio: 'pipe' }
  );
  
  return result.trim();
}

module.exports = { sshExec };
