/**
 * Mac Server Mode Fixes
 *
 * Fixes for configuring Mac as a deployment server HOST (no Docker/dev tools).
 * Focus: what makes a Mac reliable as a server.
 *
 * Power Management (pmset):
 * - Disable sleep (system, disk, display)
 * - Auto-restart on power loss
 * - Fully disable sleep (disablesleep)
 * - Wake on LAN (womp)
 * - Disable hibernate
 * - Disable standby
 * - Disable Power Nap
 * - Disable proximity wake
 * - Keep awake during SSH (ttyskeepawake)
 *
 * System Services:
 * - Disable screensaver (-currentHost)
 * - Enable SSH (Remote Login)
 * - Disable App Nap
 * - Disable Spotlight indexing
 * - Disable Time Machine
 * - Disable auto-update restart
 * - Disable Bluetooth (manual)
 * - Auto-login on boot (manual)
 *
 * Network/Security:
 * - Enable NTP (network time)
 * - Disable file sharing (manual)
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import type { Fix, FactiiiConfig, ServerOS } from '../../../../types/index.js';

// ============================================================
// Helper: generate both staging + prod fixes from one definition
// ============================================================

interface MacFixDef {
  idBase: string;
  severity: 'critical' | 'warning' | 'info';
  description: string;
  scan: (config: FactiiiConfig, rootDir: string) => Promise<boolean>;
  fix: ((config: FactiiiConfig, rootDir: string) => Promise<boolean>) | null;
  manualFix: string;
}

function macFixPair(def: MacFixDef): Fix[] {
  return (['staging', 'prod'] as const).map(stage => ({
    id: def.idBase + '-' + stage,
    stage,
    os: 'mac' as ServerOS,
    severity: def.severity,
    description: def.description,
    scan: def.scan,
    fix: def.fix,
    manualFix: def.manualFix,
  }));
}

// ============================================================
// Helper: check a pmset value
// ============================================================

function pmsetValueIs(key: string, expected: string): boolean {
  try {
    const result = execSync('pmset -g 2>/dev/null | grep -i ' + key + ' || true', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // If key not found in pmset output, the setting doesn't exist on this hardware (e.g. desktop Macs
    // don't have hibernatemode, disablesleep, proximitywake). Treat as not applicable = OK.
    if (!result.trim()) return true;
    return result.trim().includes(expected);
  } catch {
    return false;
  }
}

export const macFixes: Fix[] = [
  // ============================================================
  // POWER MANAGEMENT (pmset)
  // ============================================================

  ...macFixPair({
    idBase: 'macos-sleep-enabled',
    severity: 'warning',
    description: 'macOS sleep is enabled (server may go offline)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        const result = execSync('pmset -g | grep -E "^\\s*sleep\\s+" || true', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (!result.trim()) return false; // Key not found = not applicable
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
  }),

  ...macFixPair({
    idBase: 'macos-autorestart-disabled',
    severity: 'critical',
    description: 'Auto-restart on power loss is disabled (server may stay off after outage)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        const result = execSync('pmset -g 2>/dev/null | grep -i autorestart || true', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (!result.trim()) return false; // Key not found = not applicable
        return !result.trim().includes('1');
      } catch {
        return true;
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
  }),

  ...macFixPair({
    idBase: 'macos-disablesleep-disabled',
    severity: 'warning',
    description: 'System sleep is not fully disabled (disablesleep=0 allows Sleep menu)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        const result = execSync('pmset -g custom 2>/dev/null | grep -i disablesleep || true', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (!result.trim()) return false; // Key not found on desktop Macs = not applicable
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
  }),

  ...macFixPair({
    idBase: 'macos-wake-on-lan',
    severity: 'warning',
    description: 'Wake on LAN is disabled (cannot remotely wake server via magic packet)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      return !pmsetValueIs('womp', '1');
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('   Enabling Wake on LAN...');
        execSync('sudo pmset -a womp 1', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: sudo pmset -a womp 1 (requires Ethernet and compatible hardware)',
  }),

  ...macFixPair({
    idBase: 'macos-hibernate-enabled',
    severity: 'warning',
    description: 'Hibernate mode is enabled (server writes RAM to disk and powers off)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      return !pmsetValueIs('hibernatemode', '0');
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('   Disabling hibernate mode...');
        execSync('sudo pmset -a hibernatemode 0', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: sudo pmset -a hibernatemode 0',
  }),

  ...macFixPair({
    idBase: 'macos-standby-enabled',
    severity: 'warning',
    description: 'Standby mode is enabled (server enters deep sleep after extended idle)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        // Use 'standby ' with trailing space to avoid matching standbydelayhigh/standbydelaylow
        const result = execSync('pmset -g 2>/dev/null | grep -E "^\\s*standby\\s+" || true', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (!result.trim()) return false; // Key not found on desktop Macs = not applicable
        return !result.trim().includes('0');
      } catch {
        return true;
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('   Disabling standby mode...');
        execSync('sudo pmset -a standby 0', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: sudo pmset -a standby 0',
  }),

  ...macFixPair({
    idBase: 'macos-powernap-enabled',
    severity: 'info',
    description: 'Power Nap is enabled (wastes CPU for iCloud/Mail checks on server)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      return !pmsetValueIs('powernap', '0');
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('   Disabling Power Nap...');
        execSync('sudo pmset -a powernap 0', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: sudo pmset -a powernap 0',
  }),

  ...macFixPair({
    idBase: 'macos-proximitywake-enabled',
    severity: 'info',
    description: 'Proximity wake is enabled (nearby Apple devices can wake the Mac)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      return !pmsetValueIs('proximitywake', '0');
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('   Disabling proximity wake...');
        execSync('sudo pmset -a proximitywake 0', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: sudo pmset -a proximitywake 0',
  }),

  ...macFixPair({
    idBase: 'macos-ttyskeepawake-disabled',
    severity: 'warning',
    description: 'TTY keep-awake is disabled (Mac may sleep during active SSH sessions)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      return !pmsetValueIs('ttyskeepawake', '1');
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('   Enabling TTY keep-awake...');
        execSync('sudo pmset -a ttyskeepawake 1', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: sudo pmset -a ttyskeepawake 1',
  }),

  // ============================================================
  // SYSTEM SERVICES
  // ============================================================

  ...macFixPair({
    idBase: 'macos-ssh-disabled',
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
  }),

  ...macFixPair({
    idBase: 'macos-screensaver-enabled',
    severity: 'info',
    description: 'macOS screensaver is enabled (wasted GPU cycles on headless host)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        const result = execSync('defaults -currentHost read com.apple.screensaver idleTime 2>/dev/null || echo "300"', {
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
        execSync('defaults -currentHost write com.apple.screensaver idleTime 0', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: defaults -currentHost write com.apple.screensaver idleTime 0',
  }),

  ...macFixPair({
    idBase: 'macos-app-nap-enabled',
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
        console.log('   Disabling macOS App Nap...');
        execSync('defaults write NSGlobalDomain NSAppSleepDisabled -bool YES', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: defaults write NSGlobalDomain NSAppSleepDisabled -bool YES',
  }),

  ...macFixPair({
    idBase: 'macos-spotlight-enabled',
    severity: 'info',
    description: 'Spotlight indexing is enabled (burns CPU/disk on headless server)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        const result = execSync('mdutil -s / 2>/dev/null', {
          encoding: 'utf8',
        });
        return result.toLowerCase().includes('indexing enabled');
      } catch {
        return false;
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('   Disabling Spotlight indexing...');
        execSync('sudo mdutil -a -i off', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: sudo mdutil -a -i off',
  }),

  ...macFixPair({
    idBase: 'macos-timemachine-enabled',
    severity: 'info',
    description: 'Time Machine is enabled (causes periodic heavy disk I/O)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        const result = execSync('defaults read /Library/Preferences/com.apple.TimeMachine AutoBackup 2>/dev/null || echo "0"', {
          encoding: 'utf8',
        });
        return result.trim() === '1';
      } catch {
        return false;
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('   Disabling Time Machine...');
        execSync('sudo tmutil disable', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: sudo tmutil disable',
  }),

  ...macFixPair({
    idBase: 'macos-autoupdate-restart',
    severity: 'critical',
    description: 'macOS auto-update may reboot the server without warning',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        const result = execSync('defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates 2>/dev/null || echo "0"', {
          encoding: 'utf8',
        });
        return result.trim() === '1';
      } catch {
        return false;
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('   Disabling automatic macOS update installs...');
        execSync('sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false',
  }),

  ...macFixPair({
    idBase: 'macos-bluetooth-enabled',
    severity: 'info',
    description: 'Bluetooth is enabled (unnecessary attack surface on headless server)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        const result = execSync('defaults read /Library/Preferences/com.apple.Bluetooth ControllerPowerState 2>/dev/null || echo "1"', {
          encoding: 'utf8',
        });
        return result.trim() !== '0';
      } catch {
        return false;
      }
    },
    fix: null,
    manualFix:
      'Disable Bluetooth (only if no BT keyboard/mouse): System Settings > Bluetooth > Turn Off. ' +
      'Or: sudo defaults write /Library/Preferences/com.apple.Bluetooth ControllerPowerState -int 0 && sudo killall -HUP bluetoothd',
  }),

  ...macFixPair({
    idBase: 'macos-autologin-disabled',
    severity: 'info',
    description: 'Auto-login on boot is not configured (may require manual login after power loss)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        const plist = '/Library/Preferences/com.apple.loginwindow.plist';
        if (!fs.existsSync(plist)) return true;
        const result = execSync('defaults read ' + plist + ' autoLoginUser 2>/dev/null || echo ""', {
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
  }),

  // ============================================================
  // NETWORK / SECURITY
  // ============================================================

  ...macFixPair({
    idBase: 'macos-ntp-disabled',
    severity: 'warning',
    description: 'Network time (NTP) is disabled (accurate time needed for TLS, logs, cron)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        const result = execSync('sudo systemsetup -getusingnetworktime 2>/dev/null', {
          encoding: 'utf8',
        });
        return result.toLowerCase().includes('off');
      } catch {
        return false;
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('   Enabling network time (NTP)...');
        execSync('sudo systemsetup -setusingnetworktime on', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: sudo systemsetup -setusingnetworktime on',
  }),

  ...macFixPair({
    idBase: 'macos-file-sharing-enabled',
    severity: 'info',
    description: 'File sharing (AFP/SMB) is enabled (unnecessary attack surface on server)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        // Check if smbd is running (SMB file sharing)
        execSync('launchctl list 2>/dev/null | grep com.apple.smbd', {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return true;
      } catch {
        // smbd not running, check AFP
        try {
          const result = execSync('defaults read /Library/Preferences/com.apple.AppleFileServer guestAccess 2>/dev/null || echo "0"', {
            encoding: 'utf8',
          });
          return result.trim() === '1';
        } catch {
          return false;
        }
      }
    },
    fix: null,
    manualFix:
      'Disable file sharing: System Settings > General > Sharing > File Sharing > Off. ' +
      'Only disable if file sharing is not intentionally used.',
  }),
];
