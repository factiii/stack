/**
 * Mac Server Mode Fixes
 *
 * Fixes for configuring Mac as a deployment server HOST (no Docker/dev tools).
 * Focus: what makes a Mac reliable as a server.
 *
 * - Disable sleep (system, disk, display)
 * - Auto-restart on power loss
 * - Don't turn off when inactive (disablesleep)
 * - Disable screensaver
 * - Enable SSH (Remote Login)
 * - Disable App Nap
 * - Auto-login on boot (optional)
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
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
  {
    id: 'macos-autorestart-disabled-staging',
    stage: 'staging',
    os: 'mac' as ServerOS,
    severity: 'warning',
    description: 'Auto-restart on power loss is disabled (server may stay off after outage)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        const result = execSync('pmset -g 2>/dev/null | grep -i autorestart || true', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        // Problem if autorestart is 0 or line doesn't contain 1
        return !result.trim().includes('1');
      } catch {
        return true; // Assume needs fix if we can't read
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('   Enabling auto-restart on power loss...');
        execSync('sudo pmset -a autorestart 1', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: sudo pmset -a autorestart 1',
  },
  {
    id: 'macos-disablesleep-disabled-staging',
    stage: 'staging',
    os: 'mac' as ServerOS,
    severity: 'info',
    description: 'System sleep is not fully disabled (disablesleep=0 allows Sleep menu)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        const result = execSync('pmset -g custom 2>/dev/null | grep -i disablesleep || true', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return !result.trim().includes('1');
      } catch {
        return true;
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('   Disabling system sleep (server mode)...');
        execSync('sudo pmset -a disablesleep 1', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: sudo pmset -a disablesleep 1',
  },
  {
    id: 'macos-autologin-disabled-staging',
    stage: 'staging',
    os: 'mac' as ServerOS,
    severity: 'info',
    description: 'Auto-login on boot is not configured (may require manual login after power loss)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        const plist = '/Library/Preferences/com.apple.loginwindow.plist';
        if (!fs.existsSync(plist)) return true;
        const result = execSync(`defaults read ${plist} autoLoginUser 2>/dev/null || echo ""`, {
          encoding: 'utf8',
        });
        return !result.trim();
      } catch {
        return true;
      }
    },
    fix: null,
    manualFix:
      'Set auto-login: System Settings > Users & Groups > Login Options > Automatic login > select user. ' +
      'Or: sudo defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser -string "admin" (then reboot)',
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
  {
    id: 'macos-screensaver-enabled-prod',
    stage: 'prod',
    os: 'mac' as ServerOS,
    severity: 'info',
    description: 'macOS screensaver is enabled',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        const result = execSync('defaults read com.apple.screensaver idleTime 2>/dev/null || echo "300"', {
          encoding: 'utf8',
        });
        return parseInt(result.trim(), 10) > 0;
      } catch {
        return false;
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        execSync('defaults write com.apple.screensaver idleTime 0', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: defaults write com.apple.screensaver idleTime 0',
  },
  {
    id: 'macos-app-nap-enabled-prod',
    stage: 'prod',
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
        return true;
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        execSync('defaults write NSGlobalDomain NSAppSleepDisabled -bool YES', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: defaults write NSGlobalDomain NSAppSleepDisabled -bool YES',
  },
  {
    id: 'macos-autorestart-disabled-prod',
    stage: 'prod',
    os: 'mac' as ServerOS,
    severity: 'warning',
    description: 'Auto-restart on power loss is disabled',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        const result = execSync('pmset -g 2>/dev/null | grep -i autorestart || true', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return !result.trim().includes('1');
      } catch {
        return true;
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        execSync('sudo pmset -a autorestart 1', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: sudo pmset -a autorestart 1',
  },
  {
    id: 'macos-disablesleep-disabled-prod',
    stage: 'prod',
    os: 'mac' as ServerOS,
    severity: 'info',
    description: 'System sleep is not fully disabled',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        const result = execSync('pmset -g custom 2>/dev/null | grep -i disablesleep || true', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return !result.trim().includes('1');
      } catch {
        return true;
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        execSync('sudo pmset -a disablesleep 1', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: sudo pmset -a disablesleep 1',
  },
  {
    id: 'macos-autologin-disabled-prod',
    stage: 'prod',
    os: 'mac' as ServerOS,
    severity: 'info',
    description: 'Auto-login on boot is not configured',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        const plist = '/Library/Preferences/com.apple.loginwindow.plist';
        if (!fs.existsSync(plist)) return true;
        const result = execSync(`defaults read ${plist} autoLoginUser 2>/dev/null || echo ""`, {
          encoding: 'utf8',
        });
        return !result.trim();
      } catch {
        return true;
      }
    },
    fix: null,
    manualFix:
      'System Settings > Users & Groups > Login Options > Automatic login. Or: sudo defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser -string "admin"',
  },
];
