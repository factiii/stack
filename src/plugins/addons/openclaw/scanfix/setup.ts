/**
 * OpenClaw Addon Scanfixes
 *
 * Automates the full chain for running OpenClaw (autonomous AI agent)
 * inside a Tart VM with a local LLM via Ollama:
 *
 * 1. Install Tart on the host Mac
 * 2. Ensure a Tart VM exists and is running
 * 3. SSH into the VM to install Ollama
 * 4. Pull a compatible model (must support tool calling)
 * 5. Install OpenClaw inside the VM
 * 6. Configure OpenClaw to use the local Ollama model
 *
 * OpenClaw and Ollama run INSIDE the Tart VM, not on the host.
 * The host only needs Tart installed.
 */

import { execSync } from 'child_process';
import type { Fix, FactiiiConfig, ServerOS } from '../../../../types/index.js';

// ============================================================
// HELPER FUNCTIONS
// ============================================================

const DEFAULT_MODEL = 'qwen2.5-coder:7b';

/**
 * Get OpenClaw config merged from stack.yml and stack.local.yml
 * Local config wins (per-developer override)
 */
function getOpenClawConfig(config: FactiiiConfig, rootDir: string): { model: string } {
  const defaults = { model: DEFAULT_MODEL };

  // Check stack.yml
  const globalConf = (config as Record<string, unknown>).openclaw as
    | { model?: string }
    | undefined;

  // Check stack.local.yml
  let localConf: { model?: string } | undefined;
  try {
    const { loadLocalConfig } = require('../../../../utils/config-helpers.js');
    const local = loadLocalConfig(rootDir);
    localConf = (local as Record<string, unknown>).openclaw as { model?: string } | undefined;
  } catch {
    // No local config
  }

  return {
    model: localConf?.model ?? globalConf?.model ?? defaults.model,
  };
}

/**
 * Get the model name from config
 */
function getModelName(config: FactiiiConfig, rootDir: string): string {
  return getOpenClawConfig(config, rootDir).model;
}

/**
 * Check if Tart CLI is installed on the host
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
 * Auto-detect the first Tart VM name from `tart list`
 */
function getTartVmName(): string | null {
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
      if (parts.length >= 2 && parts[1]) {
        return parts[1];
      }
    }
    return null;
  } catch {
    return null;
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
 * Execute a command inside the Tart VM via SSH
 */
function sshVm(ip: string, cmd: string): string {
  return execSync(
    'ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 admin@' + ip + ' "' + cmd + '"',
    {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    }
  ).trim();
}

/**
 * Check if a binary is installed inside the VM
 */
function isInstalledInVm(ip: string, binary: string): boolean {
  try {
    sshVm(ip, 'which ' + binary);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Ollama is running inside the VM
 */
function isOllamaRunningInVm(ip: string): boolean {
  try {
    sshVm(ip, 'ollama list');
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a model is pulled in Ollama inside the VM
 */
function isModelPulledInVm(ip: string, model: string): boolean {
  try {
    const output = sshVm(ip, 'ollama list');
    // Model names in ollama list may include tag, e.g. "qwen2.5-coder:7b"
    const baseName = model.split(':')[0] ?? model;
    return output.includes(baseName);
  } catch {
    return false;
  }
}

/**
 * Get the VM IP if all prerequisites are met (tart installed, VM exists, running, has IP)
 * Returns null if any prerequisite fails
 */
function getReadyVmIp(): string | null {
  if (!isTartInstalled()) return null;
  const vmName = getTartVmName();
  if (!vmName) return null;
  if (!isVmRunning(vmName)) return null;
  return getVmIp(vmName);
}

// ============================================================
// SCANFIXES
// ============================================================

export const openclawFixes: Fix[] = [
  // 1. Tart CLI must be installed on the host
  {
    id: 'openclaw-tart-not-installed',
    stage: 'dev',
    os: 'mac' as ServerOS,
    severity: 'critical',
    description: 'Tart VM manager is not installed (required for OpenClaw)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      return !isTartInstalled();
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('   Installing Tart...');
        execSync('brew install cirruslabs/cli/tart', {
          stdio: 'inherit',
          timeout: 120000,
        });
        return isTartInstalled();
      } catch {
        return false;
      }
    },
    manualFix: 'Run: brew install cirruslabs/cli/tart',
  },

  // 2. A Tart VM must exist
  {
    id: 'openclaw-tart-vm-missing',
    stage: 'dev',
    os: 'mac' as ServerOS,
    severity: 'critical',
    description: 'No Tart VM image found (required for OpenClaw)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (!isTartInstalled()) return false;
      return getTartVmName() === null;
    },
    fix: null,
    manualFix: 'Run: tart clone ghcr.io/cirruslabs/macos-sequoia-base:latest sequoia-base',
  },

  // 3. The Tart VM must be running
  {
    id: 'openclaw-tart-vm-not-running',
    stage: 'dev',
    os: 'mac' as ServerOS,
    severity: 'critical',
    description: 'Tart VM is not running (required for OpenClaw)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
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
        execSync('sleep 10', { stdio: 'ignore' });
        return isVmRunning(vmName);
      } catch {
        return false;
      }
    },
    manualFix: 'Run: tart run <vm-name> (in a separate terminal)',
  },

  // 4. The VM must have an IP (network ready)
  {
    id: 'openclaw-tart-vm-no-ip',
    stage: 'dev',
    os: 'mac' as ServerOS,
    severity: 'critical',
    description: 'Cannot get Tart VM IP address (VM may still be booting)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (!isTartInstalled()) return false;
      const vmName = getTartVmName();
      if (!vmName) return false;
      if (!isVmRunning(vmName)) return false;
      return getVmIp(vmName) === null;
    },
    fix: null,
    manualFix: 'Wait 1-2 minutes for the VM to fully boot, then retry. Check: tart ip <vm-name>',
  },

  // 5. Ollama must be installed inside the VM
  {
    id: 'openclaw-ollama-not-installed',
    stage: 'dev',
    os: 'mac' as ServerOS,
    severity: 'critical',
    description: 'Ollama is not installed inside the Tart VM',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const ip = getReadyVmIp();
      if (!ip) return false;
      return !isInstalledInVm(ip, 'ollama');
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const ip = getReadyVmIp();
      if (!ip) return false;
      try {
        console.log('   Installing Ollama inside VM...');
        sshVm(ip, 'brew install ollama');
        return isInstalledInVm(ip, 'ollama');
      } catch {
        return false;
      }
    },
    manualFix: 'SSH into VM and install: ssh admin@$(tart ip <vm-name>) "brew install ollama"',
  },

  // 6. Ollama must be running inside the VM
  {
    id: 'openclaw-ollama-not-running',
    stage: 'dev',
    os: 'mac' as ServerOS,
    severity: 'critical',
    description: 'Ollama is not running inside the Tart VM',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const ip = getReadyVmIp();
      if (!ip) return false;
      if (!isInstalledInVm(ip, 'ollama')) return false;
      return !isOllamaRunningInVm(ip);
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const ip = getReadyVmIp();
      if (!ip) return false;
      try {
        console.log('   Starting Ollama inside VM...');
        // Start ollama serve in background
        execSync(
          'ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 admin@' + ip +
            ' "nohup ollama serve > /dev/null 2>&1 &"',
          { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }
        );
        execSync('sleep 3', { stdio: 'ignore' });
        return isOllamaRunningInVm(ip);
      } catch {
        return false;
      }
    },
    manualFix: 'SSH into VM and start: ssh admin@$(tart ip <vm-name>) "ollama serve"',
  },

  // 7. The configured model must be pulled
  {
    id: 'openclaw-model-not-pulled',
    stage: 'dev',
    os: 'mac' as ServerOS,
    severity: 'critical',
    description: 'Ollama model not pulled inside the Tart VM',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const ip = getReadyVmIp();
      if (!ip) return false;
      if (!isOllamaRunningInVm(ip)) return false;
      const model = getModelName(config, rootDir);
      return !isModelPulledInVm(ip, model);
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const ip = getReadyVmIp();
      if (!ip) return false;
      const model = getModelName(config, rootDir);
      try {
        console.log('   Pulling model ' + model + ' inside VM (this may take several minutes)...');
        execSync(
          'ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 admin@' + ip +
            ' "ollama pull ' + model + '"',
          { stdio: 'inherit', timeout: 600000 } // 10 min timeout for model download
        );
        return isModelPulledInVm(ip, model);
      } catch {
        return false;
      }
    },
    manualFix: 'SSH into VM and pull: ssh admin@$(tart ip <vm-name>) "ollama pull ' + DEFAULT_MODEL + '"',
  },

  // 8. OpenClaw must be installed inside the VM
  {
    id: 'openclaw-not-installed',
    stage: 'dev',
    os: 'mac' as ServerOS,
    severity: 'critical',
    description: 'OpenClaw is not installed inside the Tart VM',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const ip = getReadyVmIp();
      if (!ip) return false;
      return !isInstalledInVm(ip, 'openclaw');
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const ip = getReadyVmIp();
      if (!ip) return false;
      try {
        console.log('   Installing OpenClaw inside VM...');
        sshVm(ip, 'brew install openclaw-cli');
        return isInstalledInVm(ip, 'openclaw');
      } catch {
        return false;
      }
    },
    manualFix: 'SSH into VM and install: ssh admin@$(tart ip <vm-name>) "brew install openclaw-cli"',
  },

  // 9. OpenClaw must be configured to use the local Ollama model
  {
    id: 'openclaw-not-configured',
    stage: 'dev',
    os: 'mac' as ServerOS,
    severity: 'warning',
    description: 'OpenClaw is not configured inside the Tart VM',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const ip = getReadyVmIp();
      if (!ip) return false;
      if (!isInstalledInVm(ip, 'openclaw')) return false;
      try {
        sshVm(ip, 'test -f ~/.openclaw/openclaw.json');
        return false; // Config exists, no issue
      } catch {
        return true; // Config missing
      }
    },
    fix: null,
    manualFix:
      'SSH into VM and run the onboarding wizard:\n' +
      '      ssh admin@$(tart ip <vm-name>)\n' +
      '      openclaw onboard --install-daemon',
  },
];
