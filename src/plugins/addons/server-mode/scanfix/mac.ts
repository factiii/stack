/**
 * Mac Server Mode Fixes
 *
 * Fixes for configuring Mac as a deployment server:
 * - Disable sleep and screensaver
 * - Enable SSH (Remote Login)
 * - Disable App Nap
 * - Configure auto-login (optional)
 */

import { execSync } from 'child_process';
import type { Fix, FactiiiConfig, ServerOS } from '../../../../types/index.js';

export const macFixes: Fix[] = [
  // ============================================================
  // STAGING FIXES
  // ============================================================
  {
    id: 'macos-sleep-enabled-staging',
    stage: 'staging',
    os: 'mac' as ServerOS,
    severity: 'warning',
    description: 'macOS sleep is enabled (server may go offline)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        const result = execSync('pmset -g | grep -E "^\\s*sleep\\s+"', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        // Check if sleep is not 0
        return !result.includes('sleep 0');
      } catch {
        return false; // Can't determine, assume OK
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('   Disabling macOS sleep...');
        execSync('sudo pmset -a sleep 0 disksleep 0 displaysleep 0', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: sudo pmset -a sleep 0 disksleep 0 displaysleep 0',
  },
  {
    id: 'macos-screensaver-enabled-staging',
    stage: 'staging',
    os: 'mac' as ServerOS,
    severity: 'info',
    description: 'macOS screensaver is enabled',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        const result = execSync('defaults read com.apple.screensaver idleTime 2>/dev/null || echo "300"', {
          encoding: 'utf8',
        });
        const idleTime = parseInt(result.trim(), 10);
        return idleTime > 0;
      } catch {
        return false;
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('   Disabling macOS screensaver...');
        execSync('defaults write com.apple.screensaver idleTime 0', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: defaults write com.apple.screensaver idleTime 0',
  },
  {
    id: 'macos-ssh-disabled-staging',
    stage: 'staging',
    os: 'mac' as ServerOS,
    severity: 'critical',
    description: 'macOS Remote Login (SSH) is disabled',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        const result = execSync('sudo systemsetup -getremotelogin 2>/dev/null', {
          encoding: 'utf8',
        });
        return result.toLowerCase().includes('off');
      } catch {
        return false;
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('   Enabling macOS Remote Login (SSH)...');
        execSync('sudo systemsetup -setremotelogin on', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: sudo systemsetup -setremotelogin on',
  },
  {
    id: 'macos-app-nap-enabled-staging',
    stage: 'staging',
    os: 'mac' as ServerOS,
    severity: 'info',
    description: 'macOS App Nap may pause background processes',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        const result = execSync('defaults read NSGlobalDomain NSAppSleepDisabled 2>/dev/null || echo "0"', {
          encoding: 'utf8',
        });
        return result.trim() !== '1';
      } catch {
        return true; // If can't read, assume App Nap is enabled
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('   Disabling macOS App Nap...');
        execSync('defaults write NSGlobalDomain NSAppSleepDisabled -bool YES', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: defaults write NSGlobalDomain NSAppSleepDisabled -bool YES',
  },

  // ============================================================
  // PROD FIXES (same as staging)
  // ============================================================
  {
    id: 'macos-sleep-enabled-prod',
    stage: 'prod',
    os: 'mac' as ServerOS,
    severity: 'warning',
    description: 'macOS sleep is enabled (server may go offline)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        const result = execSync('pmset -g | grep -E "^\\s*sleep\\s+"', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return !result.includes('sleep 0');
      } catch {
        return false;
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('   Disabling macOS sleep...');
        execSync('sudo pmset -a sleep 0 disksleep 0 displaysleep 0', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: sudo pmset -a sleep 0 disksleep 0 displaysleep 0',
  },
  {
    id: 'macos-ssh-disabled-prod',
    stage: 'prod',
    os: 'mac' as ServerOS,
    severity: 'critical',
    description: 'macOS Remote Login (SSH) is disabled',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        const result = execSync('sudo systemsetup -getremotelogin 2>/dev/null', {
          encoding: 'utf8',
        });
        return result.toLowerCase().includes('off');
      } catch {
        return false;
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('   Enabling macOS Remote Login (SSH)...');
        execSync('sudo systemsetup -setremotelogin on', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: sudo systemsetup -setremotelogin on',
  },
];
