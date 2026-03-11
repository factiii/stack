/**
 * Ansible Vault Secrets fixes for Factiii Pipeline plugin
 * Handles Ansible Vault secrets validation for secrets stage
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync, spawnSync } from 'child_process';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { AnsibleVaultSecrets } from '../../../../utils/ansible-vault-secrets.js';
import { promptForSecret, promptSingleLine } from '../../../../utils/secret-prompts.js';
import { extractEnvironments, hasEnvironments } from '../../../../utils/config-helpers.js';
import { findSshKeyForStage, writeSecureKeyFile } from '../../../../utils/ssh-helper.js';

function getAnsibleStore(config: FactiiiConfig, rootDir: string): AnsibleVaultSecrets | null {
  if (!config.ansible?.vault_path) return null;
  return new AnsibleVaultSecrets({
    vault_path: config.ansible.vault_path,
    vault_password_file: config.ansible.vault_password_file,
    rootDir,
  });
}

/**
 * Write an SSH key to disk: generic name + repo-specific name.
 * e.g. staging_deploy_key AND staging_deploy_key_factiii
 */
export function writeSshKeyToDisk(stage: string, value: string, config: FactiiiConfig): string {
  const sshDir = path.join(os.homedir(), '.ssh');
  if (!fs.existsSync(sshDir)) {
    fs.mkdirSync(sshDir, { mode: 0o700 });
  }

  const genericName = stage + '_deploy_key';
  const genericPath = path.join(sshDir, genericName);
  writeSecureKeyFile(genericPath, value.trimEnd() + '\n');

  // Also write repo-specific key for multi-repo isolation
  const repoName = config.name;
  if (repoName && !repoName.toUpperCase().startsWith('EXAMPLE')) {
    const repoPath = path.join(sshDir, genericName + '_' + repoName);
    writeSecureKeyFile(repoPath, value.trimEnd() + '\n');
  }

  return genericPath;
}

/**
 * Auto-generate SSH key, copy to server, verify, and store in vault.
 * Falls back to manual paste if any step fails.
 */
/**
 * Test if an SSH key already works for connecting to a host.
 */
function testSshKey(keyPath: string, user: string, host: string): boolean {
  const result = spawnSync('ssh', [
    '-i', keyPath,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=10',
    user + '@' + host,
    'echo ok',
  ], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 20000,
  });
  return result.status === 0;
}

/**
 * Store an existing SSH key in vault and write to disk.
 */
async function storeKeyInVault(
  stage: string,
  keyPath: string,
  config: FactiiiConfig,
  store: AnsibleVaultSecrets
): Promise<boolean> {
  console.log('      Storing key in Ansible Vault...');
  try {
    const privateKey = fs.readFileSync(keyPath, 'utf8');
    const secretName = stage.toUpperCase() + '_SSH';
    const result = await store.setSecret(secretName, privateKey);
    if (!result.success) {
      console.log('      [!] Failed to store in vault: ' + (result.error ?? 'unknown'));
      return false;
    }
    console.log('      [OK] Stored ' + secretName + ' in Ansible Vault');
    writeSshKeyToDisk(stage, privateKey, config);
    console.log('      [OK] SSH key setup complete for ' + stage);
    console.log('');
    return true;
  } catch (e) {
    console.log('      [!] Vault store failed: ' + (e instanceof Error ? e.message : String(e)));
    return false;
  }
}

/**
 * Try EC2 Instance Connect to push public key to server.
 * Returns true if key was pushed and verified.
 */
async function tryEc2InstanceConnect(
  keyPath: string,
  pubKeyPath: string,
  user: string,
  host: string,
  config: FactiiiConfig
): Promise<boolean> {
  try {
    const { isAwsConfigured, getAwsConfig, getEC2Client, DescribeInstancesCommand } =
      await import('../../aws/utils/aws-helpers.js');

    if (!isAwsConfigured(config)) return false;

    const { region } = getAwsConfig(config);
    const ec2 = getEC2Client(region);

    // Find instance by public IP/DNS
    console.log('      [2/4] Trying EC2 Instance Connect...');
    const describeResult = await ec2.send(new DescribeInstancesCommand({
      Filters: [
        { Name: 'instance-state-name', Values: ['running'] },
      ],
    }));

    let instanceId: string | undefined;
    let az: string | undefined;
    for (const reservation of describeResult.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        if (instance.PublicIpAddress === host ||
            instance.PublicDnsName === host ||
            instance.PrivateIpAddress === host) {
          instanceId = instance.InstanceId;
          az = instance.Placement?.AvailabilityZone;
          break;
        }
      }
      if (instanceId) break;
    }

    if (!instanceId || !az) {
      console.log('      [!] Could not find EC2 instance for ' + host);
      return false;
    }

    // Push public key via EC2 Instance Connect
    const pubKey = fs.readFileSync(pubKeyPath, 'utf8').trim();

    const { EC2InstanceConnectClient, SendSSHPublicKeyCommand } = await import(
      '@aws-sdk/client-ec2-instance-connect'
    );
    const eicClient = new EC2InstanceConnectClient({ region });
    const sendResult = await eicClient.send(new SendSSHPublicKeyCommand({
      InstanceId: instanceId,
      InstanceOSUser: user,
      SSHPublicKey: pubKey,
      AvailabilityZone: az,
    }));

    if (!sendResult.Success) {
      console.log('      [!] EC2 Instance Connect push failed');
      return false;
    }
    console.log('      [OK] Temporary key pushed via EC2 Instance Connect (60s window)');

    // Use the temporary access to add key permanently
    console.log('      Adding key permanently to authorized_keys...');
    const addResult = spawnSync('ssh', [
      '-i', keyPath,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      user + '@' + host,
      'mkdir -p ~/.ssh && echo "' + pubKey + '" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && chmod 700 ~/.ssh && echo ok',
    ], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 20000,
    });

    if (addResult.status === 0) {
      console.log('      [OK] Key added permanently to server');
      return true;
    }

    console.log('      [!] Failed to add key permanently');
    return false;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Don't log full error for missing SDK — just skip
    if (msg.includes('Cannot find module') || msg.includes('MODULE_NOT_FOUND')) {
      console.log('      [!] EC2 Instance Connect SDK not available — skipping');
    } else {
      console.log('      [!] EC2 Instance Connect failed: ' + msg);
    }
    return false;
  }
}

async function autoGenerateAndDeploySshKey(
  stage: string,
  config: FactiiiConfig,
  rootDir: string,
  store: AnsibleVaultSecrets
): Promise<boolean> {
  const environments = extractEnvironments(config);
  const envConfig = environments[stage];
  let host = envConfig?.domain;
  const user = envConfig?.ssh_user ?? 'root';

  if (!host || host.toUpperCase().startsWith('EXAMPLE')) {
    // Try to auto-detect host from EC2 instance (Elastic IP or public IP)
    try {
      const { isAwsConfigured, getAwsConfig, getProjectName, findInstancePublicIp } =
        await import('../../aws/utils/aws-helpers.js');

      if (isAwsConfigured(config)) {
        const { region } = getAwsConfig(config);
        const projectName = getProjectName(config);
        const detectedIp = await findInstancePublicIp(projectName, region);

        if (detectedIp) {
          host = detectedIp;
          console.log('      Auto-detected EC2 host: ' + host);
          // Update stack.yml so future runs don't need to detect again
          try {
            const { updateConfigValue } = await import('../../../../utils/config-writer.js');
            const dir = rootDir || process.cwd();
            updateConfigValue(dir, stage + '.domain', host);
            updateConfigValue(dir, stage + '.ssh_user', user);
            console.log('      [OK] Updated stack.yml with ' + stage + '.domain = ' + host);
          } catch {
            // config-writer may not exist — non-fatal
          }
        }
      }
    } catch {
      // AWS not configured or SDK not available — skip detection
    }
  }

  if (!host || host.toUpperCase().startsWith('EXAMPLE')) {
    // Still no valid host — fall back to manual paste
    return await manualSshKeyEntry(stage, config, store);
  }

  const keyName = stage + '_deploy_key';
  const keyPath = path.join(os.homedir(), '.ssh', keyName);
  const pubKeyPath = keyPath + '.pub';

  console.log('');
  console.log('      ── Auto SSH Key Setup for ' + stage + ' ──');
  console.log('      Server: ' + user + '@' + host);
  console.log('');

  // Step 1: Generate key (skip if it already exists)
  if (!fs.existsSync(keyPath)) {
    console.log('      [1/4] Generating SSH key...');
    try {
      execSync(
        'ssh-keygen -t ed25519 -f "' + keyPath + '" -N "" -C "' + stage + '-deploy"',
        { stdio: 'pipe' }
      );
      // Fix permissions
      try { fs.chmodSync(keyPath, 0o600); } catch { /* Windows */ }
      console.log('      [OK] Generated: ' + keyPath);
    } catch (e) {
      console.log('      [!] ssh-keygen failed: ' + (e instanceof Error ? e.message : String(e)));
      return await manualSshKeyEntry(stage, config, store);
    }
  } else {
    console.log('      [1/4] SSH key already exists: ' + keyPath);

    // Step 1.5: Test if existing key already works (user may have added it manually)
    console.log('      Testing existing key...');
    if (testSshKey(keyPath, user, host)) {
      console.log('      [OK] Existing key works!');
      return await storeKeyInVault(stage, keyPath, config, store);
    }
    console.log('      Key not yet authorized on server');
  }

  // Step 2: Try to copy public key to server
  let keyCopied = false;

  // Step 2a: Try EC2 Instance Connect first (for AWS instances, no password needed)
  if (!keyCopied && fs.existsSync(pubKeyPath)) {
    keyCopied = await tryEc2InstanceConnect(keyPath, pubKeyPath, user, host, config);
  }

  // Step 2b: Try ssh-copy-id / ssh (requires password auth)
  if (!keyCopied) {
    console.log('      [2/4] Copying public key to server...');
    console.log('      You will be prompted for the SSH password for ' + user + '@' + host);
    console.log('');
    try {
      const pubKey = fs.readFileSync(pubKeyPath, 'utf8').trim();

      if (process.platform === 'win32') {
        const copyResult = spawnSync('ssh', [
          '-o', 'StrictHostKeyChecking=no',
          user + '@' + host,
          'mkdir -p ~/.ssh && echo "' + pubKey + '" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && chmod 700 ~/.ssh',
        ], {
          stdio: 'inherit',
          timeout: 60000,
        });
        keyCopied = copyResult.status === 0;
      } else {
        const copyResult = spawnSync('ssh-copy-id', [
          '-i', pubKeyPath,
          '-o', 'StrictHostKeyChecking=no',
          user + '@' + host,
        ], {
          stdio: 'inherit',
          timeout: 60000,
        });
        keyCopied = copyResult.status === 0;
      }
    } catch (e) {
      console.log('      [!] ssh key copy failed: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  if (!keyCopied) {
    console.log('      [!] Failed to copy public key to server');
    console.log('      Falling back to manual key paste...');
    return await manualSshKeyEntry(stage, config, store);
  }
  console.log('      [OK] Public key copied to server');

  // Step 3: Verify key auth works
  console.log('      [3/4] Verifying key auth...');
  if (!testSshKey(keyPath, user, host)) {
    console.log('      [!] Key auth verification failed');
    console.log('      Falling back to manual key paste...');
    return await manualSshKeyEntry(stage, config, store);
  }
  console.log('      [OK] Key auth verified');

  // Step 4: Store private key in vault and write to disk
  console.log('      [4/4] Storing key in Ansible Vault...');
  return await storeKeyInVault(stage, keyPath, config, store);
}

/**
 * Manual fallback: prompt user to paste an SSH private key
 */
async function manualSshKeyEntry(
  stage: string,
  config: FactiiiConfig,
  store: AnsibleVaultSecrets
): Promise<boolean> {
  try {
    const secretName = stage.toUpperCase() + '_SSH';
    const value = await promptForSecret(secretName, config);
    const result = await store.setSecret(secretName, value);
    if (!result.success) return false;

    const keyPath = writeSshKeyToDisk(stage, value, config);
    console.log('      Wrote ' + secretName + ' → ' + keyPath);
    return true;
  } catch {
    return false;
  }
}
export const secretsFixes: Fix[] = [
  {
    id: 'missing-vault-password-file',
    stage: 'secrets',
    severity: 'critical',
    description: '🔐 Vault password file not found (required to decrypt secrets)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!hasEnvironments(config)) return false;
      if (!config.ansible?.vault_password_file) return false;

      const passwordFile = config.ansible.vault_password_file.replace(/^~/, os.homedir());
      return !fs.existsSync(passwordFile);
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const passwordFile = (config.ansible?.vault_password_file ?? '~/.vault_pass')
        .replace(/^~/, os.homedir());

      console.log('');
      console.log('   Creating Ansible Vault password file: ' + passwordFile);
      console.log('   This password encrypts all your secrets (SSH keys, API tokens, etc.)');
      console.log('   Choose a strong password and save it somewhere safe.');
      console.log('');

      const password = await promptSingleLine('   Vault password: ', { hidden: true });
      if (!password || password.length < 4) {
        console.log('   Password too short (min 4 characters)');
        return false;
      }

      const confirmPass = await promptSingleLine('   Confirm password: ', { hidden: true });
      if (password !== confirmPass) {
        console.log('   Passwords do not match');
        return false;
      }

      // Ensure parent directory exists
      const parentDir = path.dirname(passwordFile);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      fs.writeFileSync(passwordFile, password + '\n', { mode: 0o600 });
      console.log('   [OK] Created ' + passwordFile);
      return true;
    },
    manualFix:
      'Create the vault password file:\n' +
      '      macOS/Linux: echo "your-vault-password" > ~/.vault_pass && chmod 600 ~/.vault_pass\n' +
      '      Windows:     echo your-vault-password > %USERPROFILE%\\.vault_pass',
  },
  {
    id: 'missing-staging-ssh',
    stage: 'secrets',
    severity: 'critical',
    description: '🔑 STAGING_SSH secret not found in Ansible Vault',
    targetStage: 'staging', // Only run when targeting staging deployment
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      // SSH key setup only runs on dev machine, not on the server itself
      if (process.env.FACTIII_ON_SERVER === 'true' || process.env.GITHUB_ACTIONS === 'true') return false;

      const environments = extractEnvironments(config);

      // Only check if staging environment is defined in config
      const hasStagingEnv = environments.staging;
      if (!hasStagingEnv) return false; // Skip check if staging not configured

      const store = getAnsibleStore(config, rootDir);
      if (!store) return false; // Will be caught by missing-ansible-config fix

      try {
        const result = await store.checkSecrets(['STAGING_SSH']);
        return result.missing?.includes('STAGING_SSH') ?? false;
      } catch {
        return false; // Vault password mismatch — handled by vault-password-mismatch scanfix
      }
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const store = getAnsibleStore(config, rootDir);
      if (!store) return false;

      return await autoGenerateAndDeploySshKey('staging', config, rootDir, store);
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
    targetStage: 'prod', // Only run when targeting prod deployment
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      // SSH key setup only runs on dev machine, not on the server itself
      if (process.env.FACTIII_ON_SERVER === 'true' || process.env.GITHUB_ACTIONS === 'true') return false;

      const environments = extractEnvironments(config);

      // Only check if prod environment is defined in config
      const hasProdEnv = environments.prod;
      if (!hasProdEnv) return false; // Skip check if prod not configured

      const store = getAnsibleStore(config, rootDir);
      if (!store) return false; // Will be caught by missing-ansible-config fix

      try {
        const result = await store.checkSecrets(['PROD_SSH']);
        return result.missing?.includes('PROD_SSH') ?? false;
      } catch {
        return false; // Vault password mismatch — handled by vault-password-mismatch scanfix
      }
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
            console.log('      Enter your AWS Access Key ID and Secret Access Key.');
            console.log('      ============================================================');
            console.log('');

            const inputAccessKeyId = await promptSingleLine('      AWS Access Key ID: ');
            const inputSecretKey = await promptSingleLine('      AWS Secret Access Key: ', { hidden: true });

            if (!inputAccessKeyId || !inputSecretKey) {
              console.log('      Access Key ID and Secret Access Key are required.');
              return false;
            }

            const { writeAwsCredentials } = await import('../../aws/utils/aws-helpers.js');
            writeAwsCredentials(inputAccessKeyId, inputSecretKey, region);

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
            // Key pair exists — AWS doesn't store private key after creation
            // Fall through to autoGenerateAndDeploySshKey() below
            console.log('      EC2 key pair "' + keyName + '" exists (private key not retrievable from AWS)');
            console.log('      Will generate a new local SSH key instead...');
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

              // Write to disk (generic + repo-specific)
              const keyPath = writeSshKeyToDisk('prod', privateKey, config);
              console.log('      [OK] Wrote PROD_SSH → ' + keyPath);
              return true;
            }
          }
        }

        // Fallback: auto-generate key (non-AWS projects or key pair already exists)
        return await autoGenerateAndDeploySshKey('prod', config, rootDir, store);
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
    targetStage: 'staging', // Only run when targeting staging deployment
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      if (process.env.FACTIII_ON_SERVER === 'true' || process.env.GITHUB_ACTIONS === 'true') return false;
      const environments = extractEnvironments(config);
      if (!environments.staging) return false;

      // Only flag if there's NO SSH key — password is the fallback
      const keyPath = path.join(os.homedir(), '.ssh', 'staging_deploy_key');
      if (fs.existsSync(keyPath)) return false;

      const store = getAnsibleStore(config, rootDir);
      if (!store) return false;

      try {
        // Check if STAGING_SSH key is in vault (if so, no need for password)
        const keyCheck = await store.checkSecrets(['STAGING_SSH']);
        if (!keyCheck.missing?.includes('STAGING_SSH')) return false;

        // No SSH key at all — check if password is stored
        const result = await store.checkSecrets(['STAGING_SSH_PASSWORD']);
        return result.missing?.includes('STAGING_SSH_PASSWORD') ?? false;
      } catch {
        return false; // Vault password mismatch — handled by vault-password-mismatch scanfix
      }
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      // Re-check: SSH key may have been created by a prior fix in this same run
      const keyPath = path.join(os.homedir(), '.ssh', 'staging_deploy_key');
      if (fs.existsSync(keyPath)) {
        console.log('      SSH key now exists — password not needed');
        return true;
      }
      const store = getAnsibleStore(config, rootDir);
      if (!store) return false;
      try {
        const keyCheck = await store.checkSecrets(['STAGING_SSH']);
        if (!keyCheck.missing?.includes('STAGING_SSH')) {
          console.log('      STAGING_SSH now in vault — password not needed');
          return true;
        }
      } catch { /* continue to password prompt */ }

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
    targetStage: 'prod', // Only run when targeting prod deployment
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      if (process.env.FACTIII_ON_SERVER === 'true' || process.env.GITHUB_ACTIONS === 'true') return false;
      const environments = extractEnvironments(config);
      if (!environments.prod) return false;

      // Only flag if there's NO SSH key — password is the fallback
      const keyPath = path.join(os.homedir(), '.ssh', 'prod_deploy_key');
      if (fs.existsSync(keyPath)) return false;

      const store = getAnsibleStore(config, rootDir);
      if (!store) return false;

      try {
        // Check if PROD_SSH key is in vault (if so, no need for password)
        const keyCheck = await store.checkSecrets(['PROD_SSH']);
        if (!keyCheck.missing?.includes('PROD_SSH')) return false;

        // No SSH key at all — check if password is stored
        const result = await store.checkSecrets(['PROD_SSH_PASSWORD']);
        return result.missing?.includes('PROD_SSH_PASSWORD') ?? false;
      } catch {
        return false; // Vault password mismatch — handled by vault-password-mismatch scanfix
      }
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      // Re-check: SSH key may have been created by a prior fix in this same run
      const keyPath = path.join(os.homedir(), '.ssh', 'prod_deploy_key');
      if (fs.existsSync(keyPath)) {
        console.log('      SSH key now exists — password not needed');
        return true;
      }
      const store = getAnsibleStore(config, rootDir);
      if (!store) return false;
      try {
        const keyCheck = await store.checkSecrets(['PROD_SSH']);
        if (!keyCheck.missing?.includes('PROD_SSH')) {
          console.log('      PROD_SSH now in vault — password not needed');
          return true;
        }
      } catch { /* continue to password prompt */ }

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
      if (process.env.FACTIII_ON_SERVER === 'true' || process.env.GITHUB_ACTIONS === 'true') return false;
      const environments = extractEnvironments(config);

      // Check if any environment uses AWS (has access_key_id or config)
      const hasAwsEnv = Object.values(environments).some(env =>
        !!env.access_key_id || !!env.config
      );
      if (!hasAwsEnv) return false;

      const store = getAnsibleStore(config, rootDir);
      if (!store) return false; // Will be caught by missing-ansible-config fix

      try {
        const result = await store.checkSecrets(['AWS_SECRET_ACCESS_KEY']);
        return result.missing?.includes('AWS_SECRET_ACCESS_KEY') ?? false;
      } catch {
        return false; // Vault password mismatch — handled by vault-password-mismatch scanfix
      }
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
    id: 'missing-ssh-key-staging',
    stage: 'secrets',
    severity: 'critical',
    description: '🔑 SSH_STAGING key file not on disk (required for staging access)',
    targetStage: 'staging', // Only run when targeting staging deployment
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (process.env.FACTIII_ON_SERVER === 'true' || process.env.GITHUB_ACTIONS === 'true') return false;
      const environments = extractEnvironments(config);

      if (!environments.staging) return false;

      return !findSshKeyForStage('staging', config.name);
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

        const keyPath = writeSshKeyToDisk('staging', key, config);
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
    targetStage: 'prod', // Only run when targeting prod deployment
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (process.env.FACTIII_ON_SERVER === 'true' || process.env.GITHUB_ACTIONS === 'true') return false;
      const environments = extractEnvironments(config);

      if (!environments.prod) return false;

      return !findSshKeyForStage('prod', config.name);
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

        const keyPath = writeSshKeyToDisk('prod', key, config);
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
