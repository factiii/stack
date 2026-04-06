/**
 * Tart VM Infrastructure Fixes
 *
 * Checks that Tart VM infrastructure is ready on the host Mac.
 * These run on the HOST machine (not inside the VM).
 *
 * - Tart CLI installed
 * - VM image exists
 * - VM is running
 * - VM has an IP (network ready)
 * - VM is SSH-accessible
 * - VM has shared directory mount
 *
 * The existing mac.ts handles hardening INSIDE the VM (sleep, SSH, screensaver, etc.).
 * This file handles the Tart layer that wraps the VM.
 */

import { execSync } from 'child_process';
import type { Fix, FactiiiConfig, ServerOS } from '../../../../types/index.js';

/**
 * Auto-detect the first Tart VM name from `tart list`
 */
function getTartVmName(): string | null {
  try {
    const output = execSync('tart list', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // tart list output format:
    // Source  Name            Disk  State
    // local   sequoia-base    50    stopped
    const lines = output.trim().split('\n');
    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && parts[1]) {
        return parts[1]; // VM name is second column
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if Tart CLI is installed
 */
function isTartInstalled(): boolean {
  try {
    execSync('which tart', { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a Tart VM is currently running
 */
function isVmRunning(vmName: string): boolean {
  try {
    const output = execSync('tart list', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = output.trim().split('\n');
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4 && parts[1] === vmName) {
        return parts[3] === 'running';
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Get the IP address of a running Tart VM
 */
function getVmIp(vmName: string): string | null {
  try {
    const ip = execSync('tart ip ' + vmName, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    }).trim();
    return ip || null;
  } catch {
    return null;
  }
}

/**
 * Check if SSH is reachable on the VM
 */
function isSshReachable(ip: string): boolean {
  try {
    execSync(
      'ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes ' + ip + ' exit 2>/dev/null',
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if we're running on the server (via SSH or CI).
 * Tart fixes manage VMs from the HOST machine, not from within the server itself.
 * When FACTIII_ON_SERVER=true, we're already on the server — skip Tart checks.
 */
function isOnServer(): boolean {
  return process.env.FACTIII_ON_SERVER === 'true' || process.env.GITHUB_ACTIONS === 'true';
}

export const tartFixes: Fix[] = [
  // ============================================================
  // STAGING FIXES
  // ============================================================
  {
    id: 'tart-not-installed-staging',
    stage: 'staging',
    os: 'mac' as ServerOS,
    severity: 'warning',
    description: 'Tart VM manager is not installed',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (isOnServer()) return false;
      return !isTartInstalled();
    },
    fix: null,
    manualFix: 'Run: brew install cirruslabs/cli/tart',
  },
  {
    id: 'tart-vm-missing-staging',
    stage: 'staging',
    os: 'mac' as ServerOS,
    severity: 'warning',
    description: 'No Tart VM image found',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (isOnServer()) return false;
      if (!isTartInstalled()) return false;
      return getTartVmName() === null;
    },
    fix: null,
    manualFix: 'Run: tart clone ghcr.io/cirruslabs/macos-sequoia-base:latest sequoia-base',
  },
  {
    id: 'tart-vm-not-running-staging',
    stage: 'staging',
    os: 'mac' as ServerOS,
    severity: 'warning',
    description: 'Tart VM is not running',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (isOnServer()) return false;
      if (!isTartInstalled()) return false;
      const vmName = getTartVmName();
      if (!vmName) return false;
      return !isVmRunning(vmName);
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const vmName = getTartVmName();
      if (!vmName) return false;
      try {
        console.log('   Starting Tart VM: ' + vmName + '...');
        execSync('tart run ' + vmName + ' &', {
          stdio: 'ignore',
          timeout: 5000,
        });
        // Wait a moment for VM to start
        execSync('sleep 5', { stdio: 'ignore' });
        return isVmRunning(vmName);
      } catch {
        return false;
      }
    },
    manualFix: 'Run: tart run <vm-name> (in a separate terminal)',
  },
  {
    id: 'tart-vm-no-ip-staging',
    stage: 'staging',
    os: 'mac' as ServerOS,
    severity: 'warning',
    description: 'Cannot get Tart VM IP address (VM may still be booting)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (isOnServer()) return false;
      if (!isTartInstalled()) return false;
      const vmName = getTartVmName();
      if (!vmName) return false;
      if (!isVmRunning(vmName)) return false;
      return getVmIp(vmName) === null;
    },
    fix: null,
    manualFix: 'Wait 1-2 minutes for the VM to fully boot, then retry. Check: tart ip <vm-name>',
  },
  {
    id: 'tart-vm-ssh-unreachable-staging',
    stage: 'staging',
    os: 'mac' as ServerOS,
    severity: 'warning',
    description: 'Cannot SSH into the Tart VM',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (isOnServer()) return false;
      if (!isTartInstalled()) return false;
      const vmName = getTartVmName();
      if (!vmName) return false;
      const ip = getVmIp(vmName);
      if (!ip) return false;
      return !isSshReachable(ip);
    },
    fix: null,
    manualFix:
      'Enable Remote Login in the VM: System Settings > General > Sharing > Remote Login. ' +
      'Or SSH in manually: ssh admin@$(tart ip <vm-name>) (password: admin)',
  },
  {
    id: 'tart-vm-shared-dir-missing-staging',
    stage: 'staging',
    os: 'mac' as ServerOS,
    severity: 'warning',
    description: 'Tart VM may not have shared directory mount (cannot verify from host)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // Cannot reliably detect shared dir config from host side
      // This is an informational check - always passes if VM is running
      return false;
    },
    fix: null,
    manualFix:
      'Stop the VM and restart with directory mount: tart stop <vm-name> && tart run --dir=core:$(pwd) <vm-name>. ' +
      'Inside VM, files appear at /Volumes/My Shared Files/core',
  },

  // ============================================================
  // PROD FIXES (same checks as staging)
  // ============================================================
  {
    id: 'tart-not-installed-prod',
    stage: 'prod',
    os: 'mac' as ServerOS,
    severity: 'warning',
    description: 'Tart VM manager is not installed',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (isOnServer()) return false;
      return !isTartInstalled();
    },
    fix: null,
    manualFix: 'Run: brew install cirruslabs/cli/tart',
  },
  {
    id: 'tart-vm-missing-prod',
    stage: 'prod',
    os: 'mac' as ServerOS,
    severity: 'warning',
    description: 'No Tart VM image found',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (isOnServer()) return false;
      if (!isTartInstalled()) return false;
      return getTartVmName() === null;
    },
    fix: null,
    manualFix: 'Run: tart clone ghcr.io/cirruslabs/macos-sequoia-base:latest sequoia-base',
  },
  {
    id: 'tart-vm-not-running-prod',
    stage: 'prod',
    os: 'mac' as ServerOS,
    severity: 'warning',
    description: 'Tart VM is not running',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (isOnServer()) return false;
      if (!isTartInstalled()) return false;
      const vmName = getTartVmName();
      if (!vmName) return false;
      return !isVmRunning(vmName);
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const vmName = getTartVmName();
      if (!vmName) return false;
      try {
        console.log('   Starting Tart VM: ' + vmName + '...');
        execSync('tart run ' + vmName + ' &', {
          stdio: 'ignore',
          timeout: 5000,
        });
        execSync('sleep 5', { stdio: 'ignore' });
        return isVmRunning(vmName);
      } catch {
        return false;
      }
    },
    manualFix: 'Run: tart run <vm-name> (in a separate terminal)',
  },
  {
    id: 'tart-vm-no-ip-prod',
    stage: 'prod',
    os: 'mac' as ServerOS,
    severity: 'warning',
    description: 'Cannot get Tart VM IP address (VM may still be booting)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (isOnServer()) return false;
      if (!isTartInstalled()) return false;
      const vmName = getTartVmName();
      if (!vmName) return false;
      if (!isVmRunning(vmName)) return false;
      return getVmIp(vmName) === null;
    },
    fix: null,
    manualFix: 'Wait 1-2 minutes for the VM to fully boot, then retry. Check: tart ip <vm-name>',
  },
  {
    id: 'tart-vm-ssh-unreachable-prod',
    stage: 'prod',
    os: 'mac' as ServerOS,
    severity: 'warning',
    description: 'Cannot SSH into the Tart VM',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (isOnServer()) return false;
      if (!isTartInstalled()) return false;
      const vmName = getTartVmName();
      if (!vmName) return false;
      const ip = getVmIp(vmName);
      if (!ip) return false;
      return !isSshReachable(ip);
    },
    fix: null,
    manualFix:
      'Enable Remote Login in the VM: System Settings > General > Sharing > Remote Login. ' +
      'Or SSH in manually: ssh admin@$(tart ip <vm-name>) (password: admin)',
  },
  {
    id: 'tart-vm-shared-dir-missing-prod',
    stage: 'prod',
    os: 'mac' as ServerOS,
    severity: 'warning',
    description: 'Tart VM may not have shared directory mount (cannot verify from host)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      return false;
    },
    fix: null,
    manualFix:
      'Stop the VM and restart with directory mount: tart stop <vm-name> && tart run --dir=core:$(pwd) <vm-name>. ' +
      'Inside VM, files appear at /Volumes/My Shared Files/core',
  },
];
