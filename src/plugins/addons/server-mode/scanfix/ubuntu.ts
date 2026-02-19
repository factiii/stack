/**
 * Ubuntu Server Mode Fixes
 *
 * Fixes for configuring Ubuntu as a deployment server:
 * - Disable suspend/sleep
 * - Enable SSH
 * - Configure UFW firewall
 * - Disable unattended upgrades auto-restart
 */

import { execSync } from 'child_process';
import * as os from 'os';
import type { Fix, FactiiiConfig, ServerOS } from '../../../../types/index.js';

/**
 * Check if running on Linux (Ubuntu fixes should not run on macOS/Windows)
 */
function isLinux(): boolean {
  return os.platform() === 'linux';
}

export const ubuntuFixes: Fix[] = [
  // ============================================================
  // STAGING FIXES
  // ============================================================
  {
    id: 'ubuntu-suspend-enabled-staging',
    stage: 'staging',
    os: 'ubuntu' as ServerOS,
    severity: 'warning',
    description: 'Ubuntu suspend/sleep is enabled (server may go offline)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (!isLinux()) return false;
      try {
        // Check if sleep.target is masked
        const result = execSync('systemctl is-enabled sleep.target 2>/dev/null || echo "unknown"', {
          encoding: 'utf8',
        });
        return !result.includes('masked');
      } catch {
        return false;
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('   Disabling Ubuntu suspend/sleep...');
        execSync('sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target', {
          stdio: 'inherit',
        });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target',
  },
  {
    id: 'ubuntu-ssh-disabled-staging',
    stage: 'staging',
    os: 'ubuntu' as ServerOS,
    severity: 'critical',
    description: 'Ubuntu SSH is not enabled',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (!isLinux()) return false;
      try {
        const result = execSync('systemctl is-active ssh 2>/dev/null || systemctl is-active sshd 2>/dev/null', {
          encoding: 'utf8',
        });
        return !result.includes('active');
      } catch {
        return true; // SSH not active
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('   Enabling Ubuntu SSH...');
        execSync('sudo apt-get install -y openssh-server && sudo systemctl enable --now ssh', {
          stdio: 'inherit',
        });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: sudo apt-get install openssh-server && sudo systemctl enable --now ssh',
  },
  {
    id: 'ubuntu-ufw-ports-staging',
    stage: 'staging',
    os: 'ubuntu' as ServerOS,
    severity: 'warning',
    description: 'UFW firewall may block required ports (22, 80, 443)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (!isLinux()) return false;
      try {
        const status = execSync('sudo ufw status 2>/dev/null || echo "inactive"', {
          encoding: 'utf8',
        });
        if (status.includes('inactive')) return false; // UFW not active, no issue

        // Check if required ports are allowed
        const ports = ['22', '80', '443'];
        for (const port of ports) {
          if (!status.includes(port)) {
            return true; // Port not allowed
          }
        }
        return false;
      } catch {
        return false;
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('   Configuring UFW firewall...');
        execSync('sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp', {
          stdio: 'inherit',
        });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: sudo ufw allow 22,80,443/tcp',
  },
  {
    id: 'ubuntu-unattended-reboot-staging',
    stage: 'staging',
    os: 'ubuntu' as ServerOS,
    severity: 'info',
    description: 'Unattended upgrades may reboot the server automatically',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (!isLinux()) return false;
      try {
        const result = execSync('cat /etc/apt/apt.conf.d/50unattended-upgrades 2>/dev/null | grep -i "Automatic-Reboot" || echo "not-found"', {
          encoding: 'utf8',
        });
        return result.includes('"true"') || result.includes('true;');
      } catch {
        return false;
      }
    },
    fix: null, // Manual fix recommended
    manualFix: 'Edit /etc/apt/apt.conf.d/50unattended-upgrades and set Unattended-Upgrade::Automatic-Reboot to "false"',
  },

  // ============================================================
  // PROD FIXES (same as staging)
  // ============================================================
  {
    id: 'ubuntu-suspend-enabled-prod',
    stage: 'prod',
    os: 'ubuntu' as ServerOS,
    severity: 'warning',
    description: 'Ubuntu suspend/sleep is enabled (server may go offline)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (!isLinux()) return false;
      try {
        const result = execSync('systemctl is-enabled sleep.target 2>/dev/null || echo "unknown"', {
          encoding: 'utf8',
        });
        return !result.includes('masked');
      } catch {
        return false;
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('   Disabling Ubuntu suspend/sleep...');
        execSync('sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target', {
          stdio: 'inherit',
        });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target',
  },
  {
    id: 'ubuntu-ssh-disabled-prod',
    stage: 'prod',
    os: 'ubuntu' as ServerOS,
    severity: 'critical',
    description: 'Ubuntu SSH is not enabled',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (!isLinux()) return false;
      try {
        const result = execSync('systemctl is-active ssh 2>/dev/null || systemctl is-active sshd 2>/dev/null', {
          encoding: 'utf8',
        });
        return !result.includes('active');
      } catch {
        return true;
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('   Enabling Ubuntu SSH...');
        execSync('sudo apt-get install -y openssh-server && sudo systemctl enable --now ssh', {
          stdio: 'inherit',
        });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: sudo apt-get install openssh-server && sudo systemctl enable --now ssh',
  },
  {
    id: 'ubuntu-ufw-ports-prod',
    stage: 'prod',
    os: 'ubuntu' as ServerOS,
    severity: 'warning',
    description: 'UFW firewall may block required ports (22, 80, 443)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (!isLinux()) return false;
      try {
        const status = execSync('sudo ufw status 2>/dev/null || echo "inactive"', {
          encoding: 'utf8',
        });
        if (status.includes('inactive')) return false;

        const ports = ['22', '80', '443'];
        for (const port of ports) {
          if (!status.includes(port)) {
            return true;
          }
        }
        return false;
      } catch {
        return false;
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('   Configuring UFW firewall...');
        execSync('sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp', {
          stdio: 'inherit',
        });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: sudo ufw allow 22,80,443/tcp',
  },
];
