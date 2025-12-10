/**
 * Mock SSH operations for testing CLI commands that require SSH access
 * This allows testing deploy/remove/check-config without real servers
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Mock file system on remote server
const mockRemoteFs = {
  configs: {},
  envFiles: {},
  directories: new Set(['~/infrastructure', '~/infrastructure/configs', '~/infrastructure/scripts/generators', '~/infrastructure/nginx'])
};

// Helper to normalize paths
function normalizePath(p) {
  return p.replace(/^~/, '').replace(/\/+/g, '/');
}

// Mock execSync for SSH commands
const originalExecSync = execSync;
const mockExecSync = (command, options) => {
  const cmd = command.toString();
  
  // Handle SSH commands
  if (cmd.includes('ssh -i')) {
    // Extract the actual command after the SSH connection
    const match = cmd.match(/"([^"]+)"/);
    if (!match) return Buffer.from('');
    
    const remoteCmd = match[1];
    
    // Handle mkdir
    if (remoteCmd.includes('mkdir -p')) {
      const dirs = remoteCmd.replace('mkdir -p', '').trim().split(' ');
      dirs.forEach(dir => mockRemoteFs.directories.add(normalizePath(dir)));
      return Buffer.from('');
    }
    
    // Handle ls (list config files)
    if (remoteCmd.includes('ls -1') && remoteCmd.includes('configs')) {
      const files = Object.keys(mockRemoteFs.configs);
      return Buffer.from(files.map(f => `~/infrastructure/configs/${f}`).join('\n'));
    }
    
    // Handle cat (read config file)
    if (remoteCmd.startsWith('cat ') && remoteCmd.includes('configs/')) {
      const filePath = remoteCmd.replace('cat ', '').trim();
      const fileName = path.basename(filePath);
      if (mockRemoteFs.configs[fileName]) {
        return Buffer.from(mockRemoteFs.configs[fileName]);
      }
      throw new Error(`File not found: ${filePath}`);
    }
    
    // Handle test -f (check if file exists)
    if (remoteCmd.includes('test -f')) {
      const filePath = remoteCmd.match(/test -f (.+?) &&/)?.[1];
      if (!filePath) return Buffer.from('no');
      const fileName = path.basename(filePath);
      return Buffer.from(mockRemoteFs.envFiles[fileName] ? 'yes' : 'no');
    }
    
    // Handle chmod
    if (remoteCmd.startsWith('chmod')) {
      return Buffer.from('');
    }
    
    // Handle docker compose commands
    if (remoteCmd.includes('docker compose')) {
      return Buffer.from('Services checked');
    }
    
    // Handle cd and script execution
    if (remoteCmd.includes('cd ~/infrastructure') || remoteCmd.includes('INFRA_DIR')) {
      // Mock script execution - just return success
      return Buffer.from('');
    }
    
    return Buffer.from('');
  }
  
  // Handle SCP commands
  if (cmd.includes('scp -i')) {
    // Extract source and destination
    const parts = cmd.split(' ');
    const srcIndex = parts.findIndex(p => p.includes('generators') || p.includes('.sh') || p.includes('.yml') || p.includes('.env'));
    const destIndex = parts.findIndex((p, i) => i > srcIndex && p.includes('@'));
    
    if (srcIndex !== -1 && destIndex !== -1) {
      const src = parts[srcIndex];
      const dest = parts[destIndex + 1];
      
      // If copying a config file, store it in mock filesystem
      if (src.endsWith('.yml') || src.endsWith('.yaml')) {
        const fileName = path.basename(src);
        if (fs.existsSync(src)) {
          mockRemoteFs.configs[fileName] = fs.readFileSync(src, 'utf8');
        }
      }
      
      // If copying env file
      if (src.includes('.env') || dest.includes('.env')) {
        const fileName = path.basename(dest);
        if (fs.existsSync(src)) {
          mockRemoteFs.envFiles[fileName] = fs.readFileSync(src, 'utf8');
        }
      }
    }
    
    return Buffer.from('');
  }
  
  // Fallback to original execSync for non-SSH commands
  return originalExecSync(command, options);
};

// Export mock utilities
module.exports = {
  mockExecSync,
  mockRemoteFs,
  resetMockFs: () => {
    mockRemoteFs.configs = {};
    mockRemoteFs.envFiles = {};
    mockRemoteFs.directories = new Set(['~/infrastructure', '~/infrastructure/configs', '~/infrastructure/scripts/generators', '~/infrastructure/nginx']);
  }
};


