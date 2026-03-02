/**
 * Ansible Vault Secrets fixes for Factiii Pipeline plugin
 * Handles Ansible Vault secrets validation for secrets stage
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { AnsibleVaultSecrets } from '../../../../utils/ansible-vault-secrets.js';
import { promptForSecret, promptSingleLine } from '../../../../utils/secret-prompts.js';
import { extractEnvironments } from '../../../../utils/config-helpers.js';

function getAnsibleStore(config: FactiiiConfig, rootDir: string): AnsibleVaultSecrets | null {
  if (!config.ansible?.vault_path) return null;
  return new AnsibleVaultSecrets({
    vault_path: config.ansible.vault_path,
    vault_password_file: config.ansible.vault_password_file,
    rootDir,
  });
}

export const secretsFixes: Fix[] = [
  {
    id: 'missing-ansible-config',
    stage: 'secrets',
    severity: 'critical',
    description: '🔐 Ansible Vault not configured (ansible.vault_path missing in stack.yml)',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      return !config.ansible?.vault_path;
    },
    fix: null,
    manualFix:
      'Add ansible section to stack.yml:\n' +
      '  ansible:\n' +
      '    vault_path: group_vars/all/vault.yml\n' +
      '    vault_password_file: ~/.vault_pass  # optional',
  },
  {
    id: 'missing-staging-ssh',
    stage: 'secrets',
    severity: 'critical',
    description: '🔑 STAGING_SSH secret not found in Ansible Vault',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const environments = extractEnvironments(config);

      // Only check if staging environment is defined in config
      const hasStagingEnv = environments.staging;
      if (!hasStagingEnv) return false; // Skip check if staging not configured

      const store = getAnsibleStore(config, rootDir);
      if (!store) return false; // Will be caught by missing-ansible-config fix

      const result = await store.checkSecrets(['STAGING_SSH']);
      return result.missing?.includes('STAGING_SSH') ?? false;
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const store = getAnsibleStore(config, rootDir);
      if (!store) return false;

      try {
        const value = await promptForSecret('STAGING_SSH', config);
        const result = await store.setSecret('STAGING_SSH', value);
        if (!result.success) return false;

        const sshDir = path.join(os.homedir(), '.ssh');
        if (!fs.existsSync(sshDir)) {
          fs.mkdirSync(sshDir, { mode: 0o700 });
        }
        const keyPath = path.join(sshDir, 'staging_deploy_key');
        fs.writeFileSync(keyPath, value.trimEnd() + '\n', { mode: 0o600 });
        console.log('      Wrote STAGING_SSH → ' + keyPath);
        return true;
      } catch {
        return false;
      }
    },
    manualFix:
      'Store your staging SSH key in the vault:\n' +
      '      1. Generate key: ssh-keygen -t ed25519 -C "staging-deploy" -f ~/.ssh/staging_deploy_key\n' +
      '      2. Add to server: ssh-copy-id -i ~/.ssh/staging_deploy_key.pub user@staging-host\n' +
      '      3. Store in vault: npx stack deploy --secrets set STAGING_SSH',
  },
  {
    id: 'missing-prod-ssh',
    stage: 'secrets',
    severity: 'critical',
    description: '🔑 PROD_SSH secret not found in Ansible Vault',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const environments = extractEnvironments(config);

      // Only check if prod environment is defined in config
      const hasProdEnv = environments.prod;
      if (!hasProdEnv) return false; // Skip check if prod not configured

      const store = getAnsibleStore(config, rootDir);
      if (!store) return false; // Will be caught by missing-ansible-config fix

      const result = await store.checkSecrets(['PROD_SSH']);
      return result.missing?.includes('PROD_SSH') ?? false;
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const store = getAnsibleStore(config, rootDir);
      if (!store) return false;

      try {
        // Check if AWS is configured for this project
        const { isAwsConfigured, getAwsConfig, getAwsAccountId, getProjectName, findKeyPair, getEC2Client, CreateKeyPairCommand } =
          await import('../../aws/utils/aws-helpers.js');

        if (isAwsConfigured(config)) {
          const { region } = getAwsConfig(config);
          const projectName = getProjectName(config);

          // Ensure AWS credentials are working
          let accountId = await getAwsAccountId(region);
          if (!accountId) {
            console.log('');
            console.log('      ============================================================');
            console.log('      AWS credentials not configured.');
            console.log('      Login with your AWS root account or an IAM admin user.');
            console.log('      ============================================================');
            console.log('');
            console.log('      Running: aws configure');
            console.log('      (Enter your Access Key ID, Secret Access Key, and region)');
            console.log('');

            try {
              execSync('aws configure', { stdio: 'inherit' });
            } catch {
              console.log('      aws configure failed');
              return false;
            }

            accountId = await getAwsAccountId(region);
            if (!accountId) {
              console.log('      AWS credentials still invalid after configuration.');
              return false;
            }
            console.log('      [OK] AWS login successful (account: ' + accountId + ')');
          }

          // Check if key pair already exists
          const keyName = 'factiii-' + projectName;
          if (await findKeyPair(keyName, region)) {
            // Key pair exists but we can't retrieve the private key from AWS
            console.log('      EC2 key pair "' + keyName + '" already exists in AWS.');
            console.log('      AWS does not store the private key after creation.');
            console.log('      Falling back to manual entry...');
            console.log('');
          } else {
            // Create new key pair — AWS returns the private key material
            console.log('      Creating EC2 key pair: ' + keyName);
            const ec2 = getEC2Client(region);
            const keyResult = await ec2.send(new CreateKeyPairCommand({
              KeyName: keyName,
              KeyType: 'ed25519',
            }));
            const privateKey = keyResult.KeyMaterial;
            if (privateKey) {
              // Store in vault
              const vaultResult = await store.setSecret('PROD_SSH', privateKey);
              if (!vaultResult.success) {
                console.log('      Failed to store PROD_SSH in vault');
                return false;
              }
              console.log('      [OK] Stored PROD_SSH in Ansible Vault');

              // Write to disk
              const sshDir = path.join(os.homedir(), '.ssh');
              if (!fs.existsSync(sshDir)) {
                fs.mkdirSync(sshDir, { mode: 0o700 });
              }
              const keyPath = path.join(sshDir, 'prod_deploy_key');
              fs.writeFileSync(keyPath, privateKey.trimEnd() + '\n', { mode: 0o600 });
              console.log('      [OK] Wrote PROD_SSH → ' + keyPath);
              return true;
            }
          }
        }

        // Fallback: manual prompt (non-AWS projects or key pair already exists)
        const value = await promptForSecret('PROD_SSH', config);
        const result = await store.setSecret('PROD_SSH', value);
        if (!result.success) return false;

        const sshDir = path.join(os.homedir(), '.ssh');
        if (!fs.existsSync(sshDir)) {
          fs.mkdirSync(sshDir, { mode: 0o700 });
        }
        const keyPath = path.join(sshDir, 'prod_deploy_key');
        fs.writeFileSync(keyPath, value.trimEnd() + '\n', { mode: 0o600 });
        console.log('      Wrote PROD_SSH → ' + keyPath);
        return true;
      } catch {
        return false;
      }
    },
    manualFix:
      'Store your prod SSH key in the vault:\n' +
      '      1. Generate key: ssh-keygen -t ed25519 -C "prod-deploy" -f ~/.ssh/prod_deploy_key\n' +
      '      2. Add to server: ssh-copy-id -i ~/.ssh/prod_deploy_key.pub user@prod-host\n' +
      '      3. Store in vault: npx stack deploy --secrets set PROD_SSH',
  },
  {
    id: 'missing-staging-ssh-password',
    stage: 'secrets',
    severity: 'warning',
    description: '🔑 STAGING_SSH_PASSWORD not in vault (needed if staging uses password auth)',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const environments = extractEnvironments(config);
      if (!environments.staging) return false;

      // Only flag if there's NO SSH key — password is the fallback
      const keyPath = path.join(os.homedir(), '.ssh', 'staging_deploy_key');
      if (fs.existsSync(keyPath)) return false;

      const store = getAnsibleStore(config, rootDir);
      if (!store) return false;

      // Check if STAGING_SSH key is in vault (if so, no need for password)
      const keyCheck = await store.checkSecrets(['STAGING_SSH']);
      if (!keyCheck.missing?.includes('STAGING_SSH')) return false;

      // No SSH key at all — check if password is stored
      const result = await store.checkSecrets(['STAGING_SSH_PASSWORD']);
      return result.missing?.includes('STAGING_SSH_PASSWORD') ?? false;
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const store = getAnsibleStore(config, rootDir);
      if (!store) return false;

      try {
        const environments = extractEnvironments(config);
        const envConfig = environments.staging;
        const host = envConfig?.domain ?? 'staging server';
        const user = envConfig?.ssh_user ?? 'root';

        console.log('      Enter the SSH password for ' + user + '@' + host);
        const password = await promptSingleLine('      Password: ', { hidden: true });
        if (!password) {
          console.log('      No password provided');
          return false;
        }

        const result = await store.setSecret('STAGING_SSH_PASSWORD', password);
        if (result.success) {
          console.log('      Stored STAGING_SSH_PASSWORD in Ansible Vault');
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    manualFix:
      'Store SSH password: npx stack deploy --secrets set STAGING_SSH_PASSWORD',
  },
  {
    id: 'missing-prod-ssh-password',
    stage: 'secrets',
    severity: 'warning',
    description: '🔑 PROD_SSH_PASSWORD not in vault (needed if prod uses password auth)',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const environments = extractEnvironments(config);
      if (!environments.prod) return false;

      // Only flag if there's NO SSH key — password is the fallback
      const keyPath = path.join(os.homedir(), '.ssh', 'prod_deploy_key');
      if (fs.existsSync(keyPath)) return false;

      const store = getAnsibleStore(config, rootDir);
      if (!store) return false;

      // Check if PROD_SSH key is in vault (if so, no need for password)
      const keyCheck = await store.checkSecrets(['PROD_SSH']);
      if (!keyCheck.missing?.includes('PROD_SSH')) return false;

      // No SSH key at all — check if password is stored
      const result = await store.checkSecrets(['PROD_SSH_PASSWORD']);
      return result.missing?.includes('PROD_SSH_PASSWORD') ?? false;
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const store = getAnsibleStore(config, rootDir);
      if (!store) return false;

      try {
        const environments = extractEnvironments(config);
        const envConfig = environments.prod;
        const host = envConfig?.domain ?? 'prod server';
        const user = envConfig?.ssh_user ?? 'root';

        console.log('      Enter the SSH password for ' + user + '@' + host);
        const password = await promptSingleLine('      Password: ', { hidden: true });
        if (!password) {
          console.log('      No password provided');
          return false;
        }

        const result = await store.setSecret('PROD_SSH_PASSWORD', password);
        if (result.success) {
          console.log('      Stored PROD_SSH_PASSWORD in Ansible Vault');
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    manualFix:
      'Store SSH password: npx stack deploy --secrets set PROD_SSH_PASSWORD',
  },
  {
    id: 'missing-aws-secret',
    stage: 'secrets',
    severity: 'warning',
    description: '🔑 AWS_SECRET_ACCESS_KEY not found in Ansible Vault (needed for ECR)',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const environments = extractEnvironments(config);

      // Check if any environment uses AWS (has access_key_id or config)
      const hasAwsEnv = Object.values(environments).some(env =>
        !!env.access_key_id || !!env.config
      );
      if (!hasAwsEnv) return false;

      const store = getAnsibleStore(config, rootDir);
      if (!store) return false; // Will be caught by missing-ansible-config fix

      const result = await store.checkSecrets(['AWS_SECRET_ACCESS_KEY']);
      return result.missing?.includes('AWS_SECRET_ACCESS_KEY') ?? false;
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const store = getAnsibleStore(config, rootDir);
      if (!store) return false;

      try {
        // Try reading from ~/.aws/credentials first
        const awsCredsPath = path.join(os.homedir(), '.aws', 'credentials');
        if (fs.existsSync(awsCredsPath)) {
          const content = fs.readFileSync(awsCredsPath, 'utf8');
          const match = content.match(/aws_secret_access_key\s*=\s*(.+)/);
          if (match && match[1]) {
            const secretKey = match[1].trim();
            if (secretKey && secretKey.length === 40) {
              console.log('   Found AWS_SECRET_ACCESS_KEY in ~/.aws/credentials');
              const result = await store.setSecret('AWS_SECRET_ACCESS_KEY', secretKey);
              if (result.success) {
                console.log('   Stored in Ansible Vault');
                return true;
              }
            }
          }
        }

        // Fall back to interactive prompt
        console.log('   AWS_SECRET_ACCESS_KEY not found in ~/.aws/credentials');
        const value = await promptForSecret('AWS_SECRET_ACCESS_KEY', config);
        const result = await store.setSecret('AWS_SECRET_ACCESS_KEY', value);
        return result.success;
      } catch {
        return false;
      }
    },
    manualFix:
      'Set AWS_SECRET_ACCESS_KEY secret: npx stack deploy --secrets set AWS_SECRET_ACCESS_KEY',
  },
  {
    id: 'missing-vault-password-file',
    stage: 'secrets',
    severity: 'critical',
    description: '🔐 Vault password file not found (required to decrypt secrets)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!config.ansible?.vault_path) return false; // Will be caught by missing-ansible-config
      if (!config.ansible.vault_password_file) return false; // Not using password file

      const passwordFile = config.ansible.vault_password_file.replace(/^~/, os.homedir());
      return !fs.existsSync(passwordFile);
    },
    fix: null,
    manualFix:
      'Create the vault password file specified in stack.yml ansible.vault_password_file:\n' +
      '      macOS/Linux: echo "your-vault-password" > ~/.vault_pass && chmod 600 ~/.vault_pass\n' +
      '      Windows:     echo your-vault-password > %USERPROFILE%\\.vault_pass',
  },
  {
    id: 'missing-ssh-key-staging',
    stage: 'secrets',
    severity: 'critical',
    description: '🔑 SSH_STAGING key file not on disk (required for staging access)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      const environments = extractEnvironments(config);

      if (!environments.staging) return false;

      const keyPath = path.join(os.homedir(), '.ssh', 'staging_deploy_key');
      return !fs.existsSync(keyPath);
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const store = getAnsibleStore(config, rootDir);
      if (!store) return false;

      try {
        const key = await store.getSecret('STAGING_SSH');
        if (!key) {
          console.log('      STAGING_SSH not in vault yet — set it first: npx stack deploy --secrets set STAGING_SSH');
          return false;
        }

        const sshDir = path.join(os.homedir(), '.ssh');
        if (!fs.existsSync(sshDir)) {
          fs.mkdirSync(sshDir, { mode: 0o700 });
        }

        const keyPath = path.join(sshDir, 'staging_deploy_key');
        fs.writeFileSync(keyPath, key.trimEnd() + '\n', { mode: 0o600 });
        console.log('      Wrote STAGING_SSH → ' + keyPath);
        return true;
      } catch {
        return false;
      }
    },
    manualFix:
      'Extract SSH keys from vault: npx stack deploy --secrets write-ssh-keys',
  },
  {
    id: 'missing-ssh-key-prod',
    stage: 'secrets',
    severity: 'critical',
    description: '🔑 SSH_PROD key file not on disk (required for prod access)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      const environments = extractEnvironments(config);

      if (!environments.prod) return false;

      const keyPath = path.join(os.homedir(), '.ssh', 'prod_deploy_key');
      return !fs.existsSync(keyPath);
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const store = getAnsibleStore(config, rootDir);
      if (!store) return false;

      try {
        const key = await store.getSecret('PROD_SSH');
        if (!key) {
          console.log('      PROD_SSH not in vault yet — set it first: npx stack deploy --secrets set PROD_SSH');
          return false;
        }

        const sshDir = path.join(os.homedir(), '.ssh');
        if (!fs.existsSync(sshDir)) {
          fs.mkdirSync(sshDir, { mode: 0o700 });
        }

        const keyPath = path.join(sshDir, 'prod_deploy_key');
        fs.writeFileSync(keyPath, key.trimEnd() + '\n', { mode: 0o600 });
        console.log('      Wrote PROD_SSH → ' + keyPath);
        return true;
      } catch {
        return false;
      }
    },
    manualFix:
      'Extract SSH keys from vault: npx stack deploy --secrets write-ssh-keys',
  },
];
