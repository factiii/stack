/**
 * SSH Verification Scanfixes
 *
 * Two concerns:
 * 1. Vault key extraction — if vault has {STAGE}_SSH but no key on disk, extract it
 * 2. SSH connectivity — if key exists, verify the connection actually works
 */

import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { findSshKeyForStage } from '../../../../utils/ssh-helper.js';
import { extractEnvironments, hasEnvironments } from '../../../../utils/config-helpers.js';
import { writeSshKeyToDisk } from './secrets.js';

/**
 * Get the Ansible vault store, or null if not configured.
 */
function getAnsibleStore(config: FactiiiConfig, rootDir: string) {
  if (!config.ansible?.vault_path) return null;
  // Lazy import to avoid circular deps
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AnsibleVaultSecrets } = require('../../../../utils/ansible-vault-secrets.js');
  return new AnsibleVaultSecrets({
    vault_path: config.ansible.vault_path,
    vault_password_file: config.ansible.vault_password_file,
    rootDir,
  });
}

/**
 * Try to read a secret from vault. Returns the value or null.
 */
async function readVaultSecret(secretName: string, config: FactiiiConfig, rootDir: string): Promise<string | null> {
  const store = getAnsibleStore(config, rootDir);
  if (!store) return null;
  try {
    const result = await store.getSecret(secretName);
    if (result.success && typeof result.value === 'string') {
      return result.value;
    }
  } catch {
    // Vault read failed
  }
  return null;
}

// ────────────────────────────────────────────────────────────
// Fix A: Extract vault SSH key to disk (secrets stage)
// ────────────────────────────────────────────────────────────

function makeVaultKeyFix(targetStage: 'staging' | 'prod'): Fix {
  const secretName = targetStage.toUpperCase() + '_SSH';
  return {
    id: 'ssh-vault-key-to-disk-' + targetStage,
    stage: 'secrets',
    targetStage,
    severity: 'critical',
    description: secretName + ' key is in vault but not on disk — extracting',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // No issue if key already exists on disk
      const keyPath = findSshKeyForStage(targetStage, config.name);
      if (keyPath) return false;

      // Check if environments exist for this stage
      if (!hasEnvironments(config)) return false;
      const envs = extractEnvironments(config);
      const stageEnvs = Object.entries(envs).filter(([name]) =>
        name === targetStage || name.startsWith(targetStage + '_')
      );
      if (stageEnvs.length === 0) return false;

      // Check if vault has the key
      const value = await readVaultSecret(secretName, config, _rootDir);
      if (!value || !value.includes('PRIVATE KEY')) return false;

      return true; // Issue: key in vault but not on disk
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const value = await readVaultSecret(secretName, config, rootDir);
      if (!value || !value.includes('PRIVATE KEY')) {
        console.log('   [!] Could not read ' + secretName + ' from vault');
        return false;
      }

      const keyPath = writeSshKeyToDisk(targetStage, value, config);
      console.log('   [OK] Extracted ' + secretName + ' to ' + keyPath);
      return true;
    },
    manualFix: 'Run: npx stack deploy --secrets write-ssh-keys',
  };
}

// ────────────────────────────────────────────────────────────
// Fix B: Verify SSH connectivity (staging/prod stage)
// ────────────────────────────────────────────────────────────

function makeSshVerifyFix(targetStage: 'staging' | 'prod'): Fix {
  return {
    id: 'ssh-verify-' + targetStage,
    stage: targetStage,
    severity: 'warning',
    description: 'SSH connection to ' + targetStage + ' server failed',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // Skip on server — no need to verify SSH to ourselves
      if (process.env.GITHUB_ACTIONS || process.env.FACTIII_ON_SERVER) return false;

      // Need a key on disk to test
      const keyPath = findSshKeyForStage(targetStage, config.name);
      if (!keyPath) return false;

      // Need environments with a domain to connect to
      if (!hasEnvironments(config)) return false;
      const envs = extractEnvironments(config);
      const stageEnvs = Object.entries(envs).filter(([name]) =>
        name === targetStage || name.startsWith(targetStage + '_')
      );
      if (stageEnvs.length === 0) return false;

      const envConfig = stageEnvs[0]?.[1];
      if (!envConfig) return false;
      const host = envConfig.domain;
      const user = envConfig.ssh_user ?? 'ubuntu';

      if (!host || host.toUpperCase().startsWith('EXAMPLE')) return false;

      // Test SSH connection
      const result = spawnSync('ssh', [
        '-i', keyPath,
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=5',
        user + '@' + host,
        'echo ok',
      ], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 15000,
      });

      // Issue detected if connection fails
      return result.status !== 0;
    },
    fix: null,
    manualFix: 'Check that the server is running, the SSH key is authorized, and security groups allow port 22.\n' +
      '   Test manually: ssh -i ~/.ssh/' + targetStage + '_deploy_key ubuntu@<host> echo ok',
  };
}

export const sshVerifyFixes: Fix[] = [
  makeVaultKeyFix('staging'),
  makeVaultKeyFix('prod'),
  makeSshVerifyFix('staging'),
  makeSshVerifyFix('prod'),
];
