/**
 * AWS SSH Bridge Fixes
 *
 * Bridges the gap between AWS EC2 key pair creation and the factiii
 * SSH key convention (Ansible Vault PROD_SSH + ~/.ssh/prod_deploy_key).
 *
 * After EC2 provisions a key pair and saves it to ~/.ssh/prod_deploy_key,
 * this fix automatically stores it in Ansible Vault as PROD_SSH so that:
 * - Other dev machines can pull the key via `npx stack deploy --secrets write-ssh-keys`
 * - The `missing-prod-ssh` secrets check passes
 * - canReach('prod') returns via: 'ssh' on subsequent runs
 *
 * Uses AWS SDK v3 for Elastic IP lookup.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import {
  getAwsConfig,
  getProjectName,
  isAwsConfigured,
  findInstance,
  findElasticIp,
} from '../utils/aws-helpers.js';

/**
 * Get the Ansible Vault store for this project (if configured)
 */
function getAnsibleStore(config: FactiiiConfig, rootDir: string) {
  if (!config.ansible?.vault_path) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AnsibleVaultSecrets } = require('../../../../utils/ansible-vault-secrets.js');
  return new AnsibleVaultSecrets({
    vault_path: config.ansible.vault_path,
    vault_password_file: config.ansible.vault_password_file,
    rootDir,
  });
}

export const sshBridgeFixes: Fix[] = [
  {
    id: 'aws-ssh-bridge-vault',
    stage: 'prod',
    severity: 'warning',
    description: '🔑 EC2 key pair exists on disk but PROD_SSH not stored in Ansible Vault',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      if (!config.ansible?.vault_path) return false;

      // Check if key file exists on disk (created by aws-keypair-missing fix)
      const keyPath = path.join(os.homedir(), '.ssh', 'prod_deploy_key');
      if (!fs.existsSync(keyPath)) return false;

      // Check if PROD_SSH is already in vault
      const store = getAnsibleStore(config, rootDir);
      if (!store) return false;

      try {
        const result = await store.checkSecrets(['PROD_SSH']);
        return result.missing?.includes('PROD_SSH') ?? false;
      } catch {
        return false;
      }
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const keyPath = path.join(os.homedir(), '.ssh', 'prod_deploy_key');
      if (!fs.existsSync(keyPath)) {
        console.log('   Key file not found at ' + keyPath);
        return false;
      }

      const store = getAnsibleStore(config, rootDir);
      if (!store) {
        console.log('   Ansible Vault not configured');
        return false;
      }

      try {
        const keyContent = fs.readFileSync(keyPath, 'utf8');
        const result = await store.setSecret('PROD_SSH', keyContent.trim());
        if (result.success) {
          console.log('   Stored EC2 key pair as PROD_SSH in Ansible Vault');
          console.log('   Other dev machines can pull it with: npx stack deploy --secrets write-ssh-keys');
          return true;
        }
        console.log('   Failed to store in vault: ' + (result.error ?? 'unknown error'));
        return false;
      } catch (e) {
        console.log('   Failed to store key in vault: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Store the EC2 key pair in vault: npx stack deploy --secrets set PROD_SSH\n' +
      '      Then paste the contents of ~/.ssh/prod_deploy_key',
  },
  {
    id: 'aws-ssh-bridge-domain',
    stage: 'prod',
    severity: 'warning',
    description: '🔑 EC2 has Elastic IP but prod.domain still has EXAMPLE- placeholder',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;

      // Check if prod domain is still a placeholder
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { extractEnvironments } = require('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);
      const prodEnv = environments.prod ?? environments.production;
      if (!prodEnv?.domain || !prodEnv.domain.toUpperCase().startsWith('EXAMPLE')) return false;

      // Check if EC2 instance has an Elastic IP
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const instanceId = await findInstance(projectName, region);
      if (!instanceId) return false;

      const eip = await findElasticIp(instanceId, region);
      return !!eip;
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const instanceId = await findInstance(projectName, region);
      if (!instanceId) {
        console.log('   EC2 instance not found');
        return false;
      }

      const eip = await findElasticIp(instanceId, region);
      if (!eip) {
        console.log('   No Elastic IP assigned to EC2 instance');
        return false;
      }

      try {
        const { updateConfigValue } = await import('../../../../utils/config-writer.js');
        const dir = rootDir || process.cwd();
        updateConfigValue(dir, 'prod.domain', eip);
        updateConfigValue(dir, 'prod.ssh_user', 'ubuntu');
        console.log('   Updated prod.domain to ' + eip + ' in stack.yml');
        console.log('   Updated prod.ssh_user to ubuntu');
        return true;
      } catch (e) {
        console.log('   Failed to update stack.yml: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Update prod.domain in stack.yml with the EC2 Elastic IP address',
  },
];
