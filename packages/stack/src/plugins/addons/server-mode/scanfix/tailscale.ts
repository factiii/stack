/**
 * Tailscale VPN Scanfix
 *
 * Installs and configures Tailscale on Mac/Linux servers for reliable
 * remote access. Tailscale creates a WireGuard tunnel that survives
 * firewall changes, port closures, and SSH misconfigurations.
 *
 * Auth key is stored in the Ansible Vault via:
 *   npx stack deploy --secrets set TAILSCALE_AUTH_KEY
 *
 * Generate the key at: https://login.tailscale.com/admin/settings/keys
 *   - Reusable + Pre-approved for servers
 */

import { execSync } from 'child_process';
import type { Fix, FactiiiConfig, ServerOS } from '../../../../types/index.js';
import { getDefaultVaultPath } from '../../../../utils/config-helpers.js';

// ============================================================
// Helpers
// ============================================================

function isTailscaleInstalled(): boolean {
  try {
    execSync('which tailscale', { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function isTailscaleRunning(): boolean {
  try {
    const result = execSync('tailscale status --json 2>/dev/null', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const status = JSON.parse(result);
    return status.BackendState === 'Running';
  } catch {
    return false;
  }
}

function isTailscaleSSHEnabled(): boolean {
  try {
    const result = execSync('tailscale status --json 2>/dev/null', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const status = JSON.parse(result);
    return status.Self?.SSH === true;
  } catch {
    return false;
  }
}

function isMac(): boolean {
  try {
    return execSync('uname -s', { encoding: 'utf8' }).trim() === 'Darwin';
  } catch {
    return false;
  }
}

async function getAuthKeyFromVault(config: FactiiiConfig): Promise<string | null> {
  try {
    const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
    const vault = new AnsibleVaultSecrets({
      vault_path: config.ansible?.vault_path ?? getDefaultVaultPath(config),
      vault_password_file: config.ansible?.vault_password_file,
    });
    return await vault.getSecret('TAILSCALE_AUTH_KEY') ?? null;
  } catch {
    return null;
  }
}

// ============================================================
// Fixes — apply to both staging and prod Mac/Linux servers
// ============================================================

function tailscaleFixPair(def: {
  idBase: string;
  severity: 'critical' | 'warning' | 'info';
  description: string;
  scan: (config: FactiiiConfig, rootDir: string) => Promise<boolean>;
  fix: ((config: FactiiiConfig, rootDir: string) => Promise<boolean>) | null;
  manualFix: string;
}): Fix[] {
  return (['staging', 'prod'] as const).map(stage => ({
    id: def.idBase + '-' + stage,
    stage,
    os: ['mac', 'ubuntu'] as ServerOS[],
    severity: def.severity,
    description: def.description,
    scan: def.scan,
    fix: def.fix,
    manualFix: def.manualFix,
  }));
}

export const tailscaleFixes: Fix[] = [
  // ── Install Tailscale ──────────────────────────────────────
  ...tailscaleFixPair({
    idBase: 'tailscale-not-installed',
    severity: 'warning',
    description: 'Tailscale not installed (no backup remote access if SSH/firewall breaks)',
    scan: async (): Promise<boolean> => {
      return !isTailscaleInstalled();
    },
    fix: async (): Promise<boolean> => {
      try {
        if (isMac()) {
          console.log('   Installing Tailscale via brew...');
          execSync('brew install --cask tailscale', { stdio: 'inherit' });
        } else {
          console.log('   Installing Tailscale...');
          execSync('curl -fsSL https://tailscale.com/install.sh | sh', { stdio: 'inherit' });
        }
        return isTailscaleInstalled();
      } catch {
        return false;
      }
    },
    manualFix:
      'macOS:  brew install --cask tailscale\n' +
      '      Linux:  curl -fsSL https://tailscale.com/install.sh | sh',
  }),

  // ── Connect to tailnet ─────────────────────────────────────
  ...tailscaleFixPair({
    idBase: 'tailscale-not-connected',
    severity: 'warning',
    description: 'Tailscale installed but not connected to tailnet',
    scan: async (): Promise<boolean> => {
      if (!isTailscaleInstalled()) return false; // Skip if not installed
      return !isTailscaleRunning();
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      try {
        const authKey = await getAuthKeyFromVault(config);
        if (authKey) {
          console.log('   Connecting to tailnet with auth key from vault...');
          execSync('sudo tailscale up --authkey=' + authKey + ' --ssh', {
            stdio: 'inherit',
          });
        } else {
          console.log('   No TAILSCALE_AUTH_KEY in vault. Starting interactive login...');
          console.log('   A browser window will open. Sign in to authorize this device.');
          execSync('sudo tailscale up --ssh', { stdio: 'inherit' });
        }
        return isTailscaleRunning();
      } catch {
        return false;
      }
    },
    manualFix:
      'With auth key:  sudo tailscale up --authkey=tskey-auth-XXXXX --ssh\n' +
      '      Interactive:   sudo tailscale up --ssh\n' +
      '      Store key:     npx stack deploy --secrets set TAILSCALE_AUTH_KEY',
  }),

  // ── Enable Tailscale SSH ───────────────────────────────────
  ...tailscaleFixPair({
    idBase: 'tailscale-ssh-disabled',
    severity: 'warning',
    description: 'Tailscale SSH not enabled (no backup SSH via tailnet)',
    scan: async (): Promise<boolean> => {
      if (!isTailscaleRunning()) return false; // Skip if not running
      return !isTailscaleSSHEnabled();
    },
    fix: async (): Promise<boolean> => {
      try {
        console.log('   Enabling Tailscale SSH...');
        execSync('sudo tailscale set --ssh', { stdio: 'inherit' });
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Run: sudo tailscale set --ssh',
  }),
];
