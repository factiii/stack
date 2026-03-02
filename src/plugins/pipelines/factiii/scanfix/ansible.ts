/**
 * Ansible fixes for Factiii Pipeline plugin
 * Handles Ansible installation for dev environment (needed for vault secrets)
 *
 * Reads stack.local.yml dev_os to pick the right installer:
 * - mac: brew install ansible
 * - windows: pip install ansible
 * - ubuntu/linux: apt-get → yum → pip fallback
 */

import { execSync } from 'child_process';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { loadLocalConfig } from '../../../../utils/config-helpers.js';

/**
 * Check if ansible-vault CLI is available
 */
function isAnsibleInstalled(): boolean {
  try {
    execSync('ansible-vault --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Determine the effective OS for installation decisions.
 * Reads stack.local.yml dev_os first, falls back to process.platform.
 */
function getDevOS(rootDir: string): 'mac' | 'windows' | 'ubuntu' {
  const localConfig = loadLocalConfig(rootDir);
  if (localConfig.dev_os) return localConfig.dev_os;

  // Fallback to process.platform
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'windows';
  return 'ubuntu';
}

/**
 * Auto-install Ansible based on dev_os from stack.local.yml
 */
function installAnsible(rootDir: string): boolean {
  const devOS = getDevOS(rootDir);

  try {
    if (devOS === 'mac') {
      console.log('   Installing Ansible via Homebrew...');
      execSync('brew install ansible', { stdio: 'inherit' });
      return true;
    }

    if (devOS === 'windows') {
      console.log('   Installing Ansible via winget...');
      execSync('winget install --id=RedHat.Ansible --accept-source-agreements --accept-package-agreements', { stdio: 'inherit' });
      return true;
    }

    // ubuntu / linux
    // Try apt first (Ubuntu/Debian)
    try {
      execSync('which apt-get', { stdio: 'pipe' });
      console.log('   Installing Ansible via apt...');
      execSync('sudo apt-get update && sudo apt-get install -y ansible', { stdio: 'inherit' });
      return true;
    } catch {
      // Not apt-based
    }

    // Try yum (RHEL/CentOS/Amazon Linux)
    try {
      execSync('which yum', { stdio: 'pipe' });
      console.log('   Installing Ansible via yum...');
      execSync('sudo yum install -y ansible', { stdio: 'inherit' });
      return true;
    } catch {
      // Not yum-based
    }

    // Fallback: pip
    console.log('   Installing Ansible via pip...');
    execSync('pip install ansible', { stdio: 'inherit' });
    return true;
  } catch (e) {
    console.log('   Failed to install Ansible: ' + (e instanceof Error ? e.message : String(e)));
    return false;
  }
}

export const ansibleFixes: Fix[] = [
  {
    id: 'ansible-not-installed',
    stage: 'dev',
    severity: 'warning',
    description: '🔧 Ansible not installed (needed for secrets management)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      return !isAnsibleInstalled();
    },
    fix: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      return installAnsible(rootDir);
    },
    manualFix: [
      'Install Ansible:',
      '  macOS:   brew install ansible',
      '  Linux:   sudo apt-get install ansible  (or sudo yum install ansible)',
      '  Windows: winget install RedHat.Ansible',
    ].join('\n'),
  },
];
