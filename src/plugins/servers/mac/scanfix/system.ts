/**
 * System-level scanfixes for fresh Mac setup
 * Checks for essential system requirements on a Mac server
 */

import { execSync } from 'child_process';
import type { Fix } from '../../../../types/index.js';

export const systemFixes: Fix[] = [
  {
    id: 'mac-homebrew-missing-dev',
    stage: 'dev',
    severity: 'critical',
    description: '🍺 Homebrew not installed (required for package management)',
    scan: async (): Promise<boolean> => {
      try {
        execSync('which brew', { stdio: 'pipe' });
        return false;
      } catch {
        return true;
      }
    },
    fix: async (): Promise<boolean> => {
      try {
        execSync(
          '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          { stdio: 'inherit' }
        );
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Install Homebrew: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
  },
  {
    id: 'mac-homebrew-missing',
    stage: 'staging',
    severity: 'critical',
    description: '🍺 Homebrew not installed (required for package management)',
    scan: async (): Promise<boolean> => {
      try {
        execSync('which brew', { stdio: 'pipe' });
        return false;
      } catch {
        return true;
      }
    },
    fix: async (): Promise<boolean> => {
      try {
        execSync(
          '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          { stdio: 'inherit' }
        );
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Install Homebrew: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
  },
  {
    id: 'mac-docker-desktop-missing',
    stage: 'staging',
    severity: 'critical',
    description: '🐳 Docker Desktop not installed',
    scan: async (): Promise<boolean> => {
      try {
        execSync('which docker', { stdio: 'pipe' });
        return false;
      } catch {
        return true;
      }
    },
    fix: async (): Promise<boolean> => {
      try {
        execSync('brew install --cask docker', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Install Docker Desktop: brew install --cask docker',
  },
  {
    id: 'mac-passwordless-sudo',
    stage: 'staging',
    severity: 'critical',
    description: '🔑 Passwordless sudo not configured (required for remote fixes)',
    scan: async (): Promise<boolean> => {
      try {
        // Check if current user can run sudo without password
        execSync('sudo -n true 2>/dev/null', { stdio: 'pipe' });
        return false; // No problem — passwordless sudo works
      } catch {
        return true; // Needs password — problem
      }
    },
    fix: null,
    manualFix: 'Enable passwordless sudo for your user:\n' +
      '  sudo visudo\n' +
      '  Add this line at the end: ' + (process.env.USER ?? '<username>') + ' ALL=(ALL) NOPASSWD: ALL\n' +
      '  Or run: echo "' + (process.env.USER ?? '<username>') + ' ALL=(ALL) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/' + (process.env.USER ?? 'deploy'),
  },
  {
    id: 'mac-ssh-server-disabled',
    stage: 'staging',
    severity: 'critical',
    description: '🔌 Remote Login (SSH) is not enabled',
    scan: async (): Promise<boolean> => {
      try {
        const output = execSync('sudo systemsetup -getremotelogin', {
          stdio: 'pipe',
          encoding: 'utf8',
        });
        return !output.toLowerCase().includes('on');
      } catch {
        // If we can't check, assume it needs fixing
        return true;
      }
    },
    fix: async (): Promise<boolean> => {
      try {
        execSync('sudo systemsetup -setremotelogin on', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Enable Remote Login: sudo systemsetup -setremotelogin on\n  Or: System Settings > General > Sharing > Remote Login',
  },
  {
    id: 'mac-firewall-ports',
    stage: 'staging',
    severity: 'warning',
    description: '🛡️ Firewall may block ports 80/443 (check manually)',
    scan: async (): Promise<boolean> => {
      try {
        const output = execSync('sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate', {
          stdio: 'pipe',
          encoding: 'utf8',
        });
        // If firewall is enabled, warn user to check ports
        return output.toLowerCase().includes('enabled');
      } catch {
        return false;
      }
    },
    fix: null,
    manualFix: 'Check firewall settings: System Settings > Network > Firewall\n  Ensure ports 80 and 443 are allowed for incoming connections.',
  },
  {
    id: 'mac-sleep-enabled',
    stage: 'staging',
    severity: 'warning',
    description: '😴 Mac may sleep when idle (servers should not sleep)',
    scan: async (): Promise<boolean> => {
      try {
        const output = execSync('pmset -g custom', {
          stdio: 'pipe',
          encoding: 'utf8',
        });
        // Check if sleep is set to something other than 0
        const sleepMatch = output.match(/\bsleep\s+(\d+)/);
        if (sleepMatch && sleepMatch[1] !== '0') {
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    fix: async (): Promise<boolean> => {
      try {
        execSync('sudo pmset -a sleep 0 displaysleep 0', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Disable sleep: sudo pmset -a sleep 0 displaysleep 0',
  },
];
