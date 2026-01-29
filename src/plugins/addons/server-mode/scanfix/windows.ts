/**
 * Windows Server Mode Fixes
 *
 * Fixes for configuring Windows as a deployment server:
 * - Disable sleep/hibernate
 * - Enable RDP or SSH
 * - Configure Windows Firewall
 * - Disable automatic restart for updates
 *
 * STATUS: Template - not fully implemented yet
 */

import type { Fix, FactiiiConfig, ServerOS } from '../../../../types/index.js';

export const windowsFixes: Fix[] = [
  // ============================================================
  // STAGING FIXES
  // ============================================================
  {
    id: 'windows-sleep-enabled-staging',
    stage: 'staging',
    os: 'windows' as ServerOS,
    severity: 'warning',
    description: 'Windows sleep/hibernate is enabled (server may go offline)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // TODO: Implement Windows sleep detection
      // powercfg /query SCHEME_CURRENT SUB_SLEEP
      return false;
    },
    fix: null, // Manual fix for now
    manualFix: 'Run PowerShell as Admin: powercfg /change standby-timeout-ac 0; powercfg /change hibernate-timeout-ac 0',
  },
  {
    id: 'windows-rdp-disabled-staging',
    stage: 'staging',
    os: 'windows' as ServerOS,
    severity: 'warning',
    description: 'Windows Remote Desktop is disabled',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // TODO: Implement RDP status check
      // Get-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections
      return false;
    },
    fix: null, // Manual fix for now
    manualFix: 'Enable Remote Desktop in System Properties > Remote, or run PowerShell as Admin: Set-ItemProperty "HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server" -Name fDenyTSConnections -Value 0',
  },
  {
    id: 'windows-firewall-ports-staging',
    stage: 'staging',
    os: 'windows' as ServerOS,
    severity: 'warning',
    description: 'Windows Firewall may block required ports (22, 80, 443, 3389)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // TODO: Implement firewall rule check
      return false;
    },
    fix: null, // Manual fix for now
    manualFix: 'Run PowerShell as Admin: New-NetFirewallRule -DisplayName "Allow HTTP" -Direction Inbound -LocalPort 80 -Protocol TCP -Action Allow; New-NetFirewallRule -DisplayName "Allow HTTPS" -Direction Inbound -LocalPort 443 -Protocol TCP -Action Allow',
  },
  {
    id: 'windows-auto-restart-staging',
    stage: 'staging',
    os: 'windows' as ServerOS,
    severity: 'info',
    description: 'Windows Update may restart the server automatically',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // TODO: Implement Windows Update auto-restart check
      return false;
    },
    fix: null, // Manual fix recommended
    manualFix: 'Configure Windows Update settings via Group Policy: Computer Configuration > Administrative Templates > Windows Components > Windows Update > Configure Automatic Updates',
  },

  // ============================================================
  // PROD FIXES (same as staging)
  // ============================================================
  {
    id: 'windows-sleep-enabled-prod',
    stage: 'prod',
    os: 'windows' as ServerOS,
    severity: 'warning',
    description: 'Windows sleep/hibernate is enabled (server may go offline)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      return false;
    },
    fix: null,
    manualFix: 'Run PowerShell as Admin: powercfg /change standby-timeout-ac 0; powercfg /change hibernate-timeout-ac 0',
  },
  {
    id: 'windows-rdp-disabled-prod',
    stage: 'prod',
    os: 'windows' as ServerOS,
    severity: 'warning',
    description: 'Windows Remote Desktop is disabled',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      return false;
    },
    fix: null,
    manualFix: 'Enable Remote Desktop in System Properties > Remote',
  },
  {
    id: 'windows-firewall-ports-prod',
    stage: 'prod',
    os: 'windows' as ServerOS,
    severity: 'warning',
    description: 'Windows Firewall may block required ports (22, 80, 443, 3389)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      return false;
    },
    fix: null,
    manualFix: 'Configure Windows Firewall to allow ports 80, 443, and 3389 (RDP)',
  },
];
