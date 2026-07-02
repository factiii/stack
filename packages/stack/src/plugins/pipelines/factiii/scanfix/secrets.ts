/**
 * Ansible Vault Secrets fixes for Factiii Pipeline plugin
 * Handles Ansible Vault secrets validation (vault unlock, SSH key extraction)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync, spawnSync } from 'child_process';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { AnsibleVaultSecrets } from '../../../../utils/ansible-vault-secrets.js';
import { promptForSecret, promptSingleLine, confirm } from '../../../../utils/secret-prompts.js';
import { wrapPassword } from '../../../../utils/vault-key.js';
import { extractEnvironments, hasEnvironments } from '../../../../utils/config-helpers.js';
import { findSshKeyForStage, writeSecureKeyFile } from '../../../../utils/ssh-helper.js';
import { getStackSshKeyPath, getStackSshDir } from '../../../../utils/ssh-paths.js';
import { getStackProjectName } from '../../../../utils/project-identifier.js';

function getAnsibleStore(config: FactiiiConfig, rootDir: string): AnsibleVaultSecrets | null {
  if (!config.ansible?.vault_path) return null;
  return new AnsibleVaultSecrets({
    vault_path: config.ansible.vault_path,
    vault_password_file: config.ansible.vault_password_file,
    rootDir,
  });
}

/**
 * Write an SSH key to disk at the per-project isolated path.
 * e.g. ~/.ssh/factiii/<projectName>/<stage>_deploy_key
 */
export function writeSshKeyToDisk(stage: string, value: string, config: FactiiiConfig): string {
  const projectName = getStackProjectName(config);
  const targetDir = getStackSshDir(projectName);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  }

  const keyPath = getStackSshKeyPath(projectName, stage);
  writeSecureKeyFile(keyPath, value.trimEnd() + '\n');

  return keyPath;
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
): Promise<{ added: boolean; connectedHost?: string }> {
  try {
    const { isAwsConfigured, getAwsConfig, getProjectName, findInstance, findInstancePublicIp,
      getEC2Client, getEC2ICClient, DescribeInstancesCommand, SendSSHPublicKeyCommand } =
      await import('../../aws/utils/aws-helpers.js');

    if (!isAwsConfigured(config)) return { added: false };

    const { region } = getAwsConfig(config);
    const projectName = getProjectName(config);
    const ec2 = getEC2Client(region);

    console.log('      [2/4] Trying EC2 Instance Connect...');

    // Find instance — try multiple strategies:
    // 1. By factiii:project tag (standard for instances created by stack)
    let instanceId = await findInstance(projectName, region);

    // 2. By key pair name (instances may not have tags if created before tagging was added)
    if (!instanceId) {
      try {
        const keyPairName = 'factiii-' + projectName;
        const desc = await ec2.send(new DescribeInstancesCommand({
          Filters: [
            { Name: 'key-name', Values: [keyPairName] },
            { Name: 'instance-state-name', Values: ['running', 'stopped'] },
          ],
        }));
        instanceId = desc.Reservations?.[0]?.Instances?.[0]?.InstanceId ?? null;
        if (instanceId) {
          console.log('      Found instance by key pair: ' + keyPairName);
        }
      } catch {
        // continue to next strategy
      }
    }

    // 3. By IP matching (resolve domain → match against running instances)
    if (!instanceId) {
      const matchIps = new Set<string>();
      // Resolve domain to IPs
      try {
        const dns = await import('dns');
        const resolved = await new Promise<string[]>((resolve, reject) => {
          dns.resolve4(host, (err, addresses) => {
            if (err) reject(err);
            else resolve(addresses);
          });
        });
        for (const ip of resolved) matchIps.add(ip);
      } catch {
        // Domain doesn't resolve — try host as-is (might be an IP)
        if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) matchIps.add(host);
      }

      if (matchIps.size > 0) {
        try {
          const desc = await ec2.send(new DescribeInstancesCommand({
            Filters: [{ Name: 'instance-state-name', Values: ['running'] }],
          }));
          for (const reservation of desc.Reservations ?? []) {
            for (const inst of reservation.Instances ?? []) {
              if ((inst.PublicIpAddress && matchIps.has(inst.PublicIpAddress)) ||
                  (inst.PrivateIpAddress && matchIps.has(inst.PrivateIpAddress))) {
                instanceId = inst.InstanceId ?? null;
                break;
              }
            }
            if (instanceId) break;
          }
          if (instanceId) {
            console.log('      Found instance by IP matching');
          }
        } catch {
          // continue
        }
      }
    }

    if (!instanceId) {
      console.log('      [!] Could not find EC2 instance (tried: tag, key-pair, IP matching)');
      return { added: false };
    }

    // Get instance details for AZ and public IP
    const desc = await ec2.send(new DescribeInstancesCommand({
      InstanceIds: [instanceId],
    }));
    const instance = desc.Reservations?.[0]?.Instances?.[0];
    const az = instance?.Placement?.AvailabilityZone;
    if (!az) {
      console.log('      [!] Could not get instance availability zone');
      return { added: false };
    }

    // Get public IP (prefers Elastic IP for stability)
    const instancePublicIp = instance?.PublicIpAddress ??
      (await findInstancePublicIp(projectName, region)) ?? undefined;

    const pubKey = fs.readFileSync(pubKeyPath, 'utf8').trim();

    // Build targets: try EC2 IP first (direct, reliable), then domain
    const targets: string[] = [];
    if (instancePublicIp) targets.push(instancePublicIp);
    if (host !== instancePublicIp) targets.push(host);

    if (targets.length === 0) {
      console.log('      [!] No reachable target (no public IP or domain)');
      return { added: false };
    }

    const addKeyCmd = 'mkdir -p ~/.ssh && echo "' + pubKey + '" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && chmod 700 ~/.ssh && sort -u -o ~/.ssh/authorized_keys ~/.ssh/authorized_keys && echo ok';

    let added = false;
    let connectedHost: string | undefined;
    for (const target of targets) {
      // Push fresh temporary key via EC2 Instance Connect before each attempt (60s window per push)
      const eicClient = getEC2ICClient(region);
      const sendResult = await eicClient.send(new SendSSHPublicKeyCommand({
        InstanceId: instanceId,
        InstanceOSUser: user,
        SSHPublicKey: pubKey,
        AvailabilityZone: az,
      }));

      if (!sendResult.Success) {
        console.log('      [!] EC2 Instance Connect push failed for ' + target);
        continue;
      }
      console.log('      [OK] Temporary key pushed via EC2 Instance Connect (60s window)');

      // Add key permanently to authorized_keys
      console.log('      Adding key permanently to authorized_keys via ' + target + '...');
      const addResult = spawnSync('ssh', [
        '-i', keyPath,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=15',
        user + '@' + target,
        addKeyCmd,
      ], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 30000,
      });

      if (addResult.status === 0) {
        console.log('      [OK] Key added permanently via ' + target);
        added = true;
        connectedHost = target;
        break;
      }
      const errLine = addResult.stderr ? addResult.stderr.trim().split('\n')[0] : '';
      console.log('      [!] Failed via ' + target + (errLine ? ': ' + errLine : ''));
    }

    if (!added) {
      console.log('      [!] Failed to add key permanently (tried: ' + targets.join(', ') + ')');
    }
    return { added, connectedHost };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Don't log full error for missing SDK — just skip
    if (msg.includes('Cannot find module') || msg.includes('MODULE_NOT_FOUND')) {
      console.log('      [!] EC2 Instance Connect SDK not available — skipping');
    } else {
      console.log('      [!] EC2 Instance Connect failed: ' + msg);
    }
    return { added: false };
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
      const { isAwsConfigured, getAwsConfig, getProjectName, findInstancePublicIp,
        findInstance: findInst, findElasticIp: findEip, getEC2Client: getEc2,
        DescribeInstancesCommand: DescInst } =
        await import('../../aws/utils/aws-helpers.js');

      if (isAwsConfigured(config)) {
        const { region } = getAwsConfig(config);
        const projectName = getProjectName(config);

        // Try tag-based lookup first
        let detectedIp = await findInstancePublicIp(projectName, region);

        // Fallback: find by key pair name if tags don't match
        if (!detectedIp) {
          try {
            const ec2 = getEc2(region);
            const keyPairName = 'factiii-' + projectName;
            const descResult = await ec2.send(new DescInst({
              Filters: [
                { Name: 'key-name', Values: [keyPairName] },
                { Name: 'instance-state-name', Values: ['running'] },
              ],
            }));
            const inst = descResult.Reservations?.[0]?.Instances?.[0];
            if (inst) {
              // Check for Elastic IP first, then public IP
              if (inst.InstanceId) {
                detectedIp = await findEip(inst.InstanceId, region);
              }
              if (!detectedIp) {
                detectedIp = inst.PublicIpAddress ?? null;
              }
            }
          } catch {
            // continue
          }
        }

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

  const projectName = getStackProjectName(config);
  const sshTargetDir = getStackSshDir(projectName);
  if (!fs.existsSync(sshTargetDir)) {
    fs.mkdirSync(sshTargetDir, { recursive: true, mode: 0o700 });
  }
  const keyPath = getStackSshKeyPath(projectName, stage);
  const pubKeyPath = keyPath + '.pub';

  console.log('');
  console.log('      ── Auto SSH Key Setup for ' + stage + ' ──');
  console.log('      Server: ' + user + '@' + host);
  console.log('');

  // Detect if THIS STAGE uses AWS (not project-wide — staging may be non-AWS while prod is AWS)
  let isAwsStage = false;
  let ec2PublicIp: string | undefined;
  try {
    const { getEnvironmentsForStage: getEnvsForStage } = await import('../../../../utils/config-helpers.js');
    const stageEnvs = getEnvsForStage(config, stage as any);
    const stageEnvValues = Object.values(stageEnvs);
    isAwsStage = stageEnvValues.some((e: any) =>
      e.pipeline === 'aws' || !!e.access_key_id || (!!e.config && ['ec2', 'free-tier', 'standard', 'enterprise'].includes(e.config))
    );
  } catch {
    // config-helpers not available
  }

  if (isAwsStage) {
    try {
      const { getAwsConfig: getAws, getProjectName: getProjName,
        findInstancePublicIp: findIp, findElasticIp: findEip2,
        getEC2Client: getEc2b, DescribeInstancesCommand: DescInst2 } =
        await import('../../aws/utils/aws-helpers.js');
      const { region } = getAws(config);
      const projName = getProjName(config);
      ec2PublicIp = (await findIp(projName, region)) ?? undefined;

      // Fallback: find by key pair name if tag-based lookup fails
      if (!ec2PublicIp) {
        try {
          const ec2b = getEc2b(region);
          const descResult = await ec2b.send(new DescInst2({
            Filters: [
              { Name: 'key-name', Values: ['factiii-' + projName] },
              { Name: 'instance-state-name', Values: ['running'] },
            ],
          }));
          const inst = descResult.Reservations?.[0]?.Instances?.[0];
          if (inst?.InstanceId) {
            ec2PublicIp = (await findEip2(inst.InstanceId, region)) ?? inst.PublicIpAddress ?? undefined;
          }
        } catch {
          // continue
        }
      }
    } catch {
      // AWS SDK not available
    }
  }

  // Step 1: Generate key (skip if it already exists)
  if (!fs.existsSync(keyPath)) {
    console.log('      [1/4] Generating SSH key...');
    try {
      execSync(
        'ssh-keygen -t ed25519 -f "' + keyPath + '" -N "" -C "' + stage + '-deploy"',
        { stdio: 'pipe' }
      );
      // Fix permissions (writeSecureKeyFile uses icacls on Windows instead of no-op chmodSync)
      writeSecureKeyFile(keyPath, fs.readFileSync(keyPath, 'utf8'));
      console.log('      [OK] Generated: ' + keyPath);
    } catch (e) {
      console.log('      [!] ssh-keygen failed: ' + (e instanceof Error ? e.message : String(e)));
      return await manualSshKeyEntry(stage, config, store);
    }
  } else {
    console.log('      [1/4] SSH key already exists: ' + keyPath);

    // Step 1.5: Test if existing key already works (try both domain and EC2 IP)
    console.log('      Testing existing key...');
    if (testSshKey(keyPath, user, host)) {
      console.log('      [OK] Existing key works!');
      return await storeKeyInVault(stage, keyPath, config, store);
    }
    // Also try EC2 public IP if different from domain
    if (ec2PublicIp && ec2PublicIp !== host && testSshKey(keyPath, user, ec2PublicIp)) {
      console.log('      [OK] Existing key works via EC2 IP (' + ec2PublicIp + ')');
      return await storeKeyInVault(stage, keyPath, config, store);
    }
    console.log('      Key not yet authorized on server');

    // Regenerate .pub file if missing (needed for EC2 Instance Connect)
    if (!fs.existsSync(pubKeyPath)) {
      try {
        const pubKeyResult = spawnSync('ssh-keygen', ['-y', '-f', keyPath], { encoding: 'utf8', stdio: 'pipe' });
        if (pubKeyResult.status === 0 && pubKeyResult.stdout) {
          fs.writeFileSync(pubKeyPath, pubKeyResult.stdout);
          console.log('      [OK] Regenerated public key: ' + pubKeyPath);
        } else {
          console.log('      [!] Could not regenerate .pub file');
        }
      } catch {
        console.log('      [!] Could not regenerate .pub file');
      }
    }
  }

  // Step 2: Try to copy public key to server
  let keyCopied = false;
  let connectedVia: string | undefined;

  // Step 2a: Try EC2 Instance Connect first (for AWS instances, no password needed)
  if (!keyCopied && fs.existsSync(pubKeyPath)) {
    const eicResult = await tryEc2InstanceConnect(keyPath, pubKeyPath, user, host, config);
    keyCopied = eicResult.added;
    connectedVia = eicResult.connectedHost;
  }

  // Step 2b: Try ssh-copy-id / ssh (requires password auth) — skip for AWS EC2 (no password auth)
  if (!keyCopied && !isAwsStage) {
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

  // Step 3: Verify key auth works (try the host that worked during copy, then others)
  console.log('      [3/4] Verifying key auth...');
  const verifyHost = connectedVia ?? host;
  const keyWorks = testSshKey(keyPath, user, verifyHost) ||
    (verifyHost !== host && testSshKey(keyPath, user, host)) ||
    (ec2PublicIp && ec2PublicIp !== verifyHost && ec2PublicIp !== host && testSshKey(keyPath, user, ec2PublicIp));
  if (!keyWorks) {
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
    stage: 'dev',
    severity: 'critical',
    description: '🔐 Vault password file not found (required to decrypt secrets)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      // Vault password is managed locally — skip on server
      if (process.env.FACTIII_ON_SERVER === 'true' || process.env.GITHUB_ACTIONS === 'true') return false;
      if (!hasEnvironments(config)) return false;
      if (!config.ansible?.vault_password_file) return false;

      const passwordFile = config.ansible.vault_password_file.replace(/^~/, os.homedir());
      return !fs.existsSync(passwordFile);
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      if (!config.ansible?.vault_password_file) {
        console.log('   ansible.vault_password_file not configured in stack.yml');
        return false;
      }
      const passwordFile = config.ansible.vault_password_file.replace(/^~/, os.homedir());

      // Two DISTINCT secrets — never conflate them:
      //   - VAULT KEY: the strong secret that ansible-encrypts the vault file.
      //     Shared across the team out-of-band. NEVER stored in the clear.
      //   - PERSONAL PASSWORD: local-only; encrypts the vault key at rest in
      //     ~/.vault_pass (STACKVAULT1 wrap). Each developer chooses their own.
      // We generate (fresh) or import (existing vault) the key, then wrap it
      // with the personal password. The password is NOT the key.
      const vaultPath = config.ansible?.vault_path ?? '';
      const fullVaultPath = vaultPath
        ? (path.isAbsolute(vaultPath) ? vaultPath : path.join(rootDir, vaultPath))
        : '';
      const vaultExists = !!fullVaultPath && fs.existsSync(fullVaultPath);

      let vaultKey: string;
      if (vaultExists) {
        // An encrypted vault already exists; a freshly generated key could not
        // decrypt it. Import the SHARED vault key (teammate's export-vault).
        console.log('');
        console.log('   An encrypted vault already exists (' + vaultPath + ').');
        console.log('   Paste the SHARED VAULT KEY that decrypts it — not a password you invent.');
        console.log('   A teammate reveals it with: npx stack deploy --secrets export-vault');
        console.log('');
        vaultKey = (await promptSingleLine('   Vault key: ', { hidden: true })).trim();
        if (!vaultKey) {
          console.log('   Vault key cannot be empty');
          return false;
        }
      } else {
        // Fresh setup — generate a strong random vault key. The user never types
        // it, so it can never equal their personal password.
        vaultKey = crypto.randomBytes(32).toString('base64');
        console.log('');
        console.log('   Generated a new strong vault key (random, 256-bit).');
        console.log('   It encrypts all your secrets. Back it up after setup with:');
        console.log('     npx stack deploy --secrets export-vault');
        console.log('');
      }

      // Personal password — encrypts the vault key on THIS machine only.
      console.log('   Choose a personal password to protect the vault key on this machine.');
      console.log('   It is local to you (teammates pick their own) and is asked for on vault commands.');
      console.log('');
      const userPassword = await promptSingleLine('   Personal password (min 8 chars): ', { hidden: true });
      if (!userPassword || userPassword.length < 8) {
        console.log('   Password too short (min 8 characters)');
        return false;
      }
      const confirmPass = await promptSingleLine('   Confirm password: ', { hidden: true });
      if (userPassword !== confirmPass) {
        console.log('   Passwords do not match');
        return false;
      }

      // Ensure parent directory exists
      const parentDir = path.dirname(passwordFile);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      // Persist ONLY the wrapped (encrypted) vault key — never the raw key.
      const wrapped = await wrapPassword(vaultKey, userPassword);
      fs.writeFileSync(passwordFile, wrapped, { mode: 0o600 });
      console.log('   [OK] Created ' + passwordFile + ' (vault key encrypted with your personal password)');
      if (!vaultExists) {
        console.log('   [!] Save your vault key now so teammates/servers can use it:');
        console.log('       npx stack deploy --secrets export-vault');
      }
      return true;
    },
    manualFix:
      'Run `npx stack fix --dev` to generate (or import) a vault key and encrypt it with your personal password.\n' +
      '      Joining an existing vault? Import the shared key: npx stack deploy --secrets import-vault\n' +
      '      (Do not hand-write a plaintext .vault_pass — the vault key must never be stored in the clear.)',
  },
  {
    id: 'missing-staging-ssh',
    stage: 'dev',
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

      console.log('');
      const pasteExisting = await confirm('      Do you have an existing SSH key to paste?', false);
      if (pasteExisting) {
        return await manualSshKeyEntry('staging', config, store);
      }

      console.log('      Auto-generating and deploying a new SSH key...');
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
    stage: 'dev',
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

      // Ask upfront if user wants to paste an existing key
      console.log('');
      const pasteExisting = await confirm('      Do you have an existing SSH key to paste?', false);
      if (pasteExisting) {
        return await manualSshKeyEntry('prod', config, store);
      }

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

            const { setLoadedCredentials } = await import('../../aws/utils/aws-helpers.js');
            setLoadedCredentials({ accessKeyId: inputAccessKeyId, secretAccessKey: inputSecretKey, region });

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
            // Must generate a local key and use EC2 Instance Connect to add it
            console.log('      EC2 key pair "' + keyName + '" exists (private key not retrievable from AWS)');
            console.log('      Will generate a local SSH key and use EC2 Instance Connect to authorize it...');
            console.log('');

            // Import additional helpers for instance discovery
            const { findInstance, findElasticIp, findInstancePublicIp,
              DescribeInstancesCommand, getEC2ICClient, SendSSHPublicKeyCommand } =
              await import('../../aws/utils/aws-helpers.js');

            // Find the EC2 instance using multiple strategies
            const ec2 = getEC2Client(region);
            let instanceId = await findInstance(projectName, region);

            // Try by key pair name if tag lookup fails
            if (!instanceId) {
              try {
                const desc = await ec2.send(new DescribeInstancesCommand({
                  Filters: [
                    { Name: 'key-name', Values: [keyName] },
                    { Name: 'instance-state-name', Values: ['running', 'stopped'] },
                  ],
                }));
                instanceId = desc.Reservations?.[0]?.Instances?.[0]?.InstanceId ?? null;
                if (instanceId) console.log('      Found EC2 instance by key pair: ' + instanceId);
              } catch {
                // continue
              }
            }

            // Try resolving the prod domain to find instance
            if (!instanceId) {
              const environments = extractEnvironments(config);
              const prodDomain = environments.prod?.domain;
              if (prodDomain && !prodDomain.toUpperCase().startsWith('EXAMPLE')) {
                try {
                  const dns = await import('dns');
                  const resolved = await new Promise<string[]>((resolve, reject) => {
                    dns.resolve4(prodDomain, (err, addresses) => {
                      if (err) reject(err);
                      else resolve(addresses);
                    });
                  });
                  if (resolved.length > 0) {
                    const desc = await ec2.send(new DescribeInstancesCommand({
                      Filters: [{ Name: 'instance-state-name', Values: ['running'] }],
                    }));
                    for (const r of desc.Reservations ?? []) {
                      for (const inst of r.Instances ?? []) {
                        if (inst.PublicIpAddress && resolved.includes(inst.PublicIpAddress)) {
                          instanceId = inst.InstanceId ?? null;
                          if (instanceId) console.log('      Found EC2 instance by domain resolution: ' + instanceId);
                          break;
                        }
                      }
                      if (instanceId) break;
                    }
                  }
                } catch {
                  // DNS resolution failed — continue
                }
              }
            }

            // List ALL running instances as last resort — prefer newest (most recently launched)
            if (!instanceId) {
              try {
                const desc = await ec2.send(new DescribeInstancesCommand({
                  Filters: [{ Name: 'instance-state-name', Values: ['running'] }],
                }));
                const allInstances: { id: string; ip?: string; name?: string; launchTime?: Date }[] = [];
                for (const r of desc.Reservations ?? []) {
                  for (const inst of r.Instances ?? []) {
                    if (inst.InstanceId) {
                      const nameTag = inst.Tags?.find(t => t.Key === 'Name');
                      allInstances.push({
                        id: inst.InstanceId,
                        ip: inst.PublicIpAddress ?? undefined,
                        name: nameTag?.Value ?? undefined,
                        launchTime: inst.LaunchTime,
                      });
                    }
                  }
                }
                // Sort newest first
                allInstances.sort((a, b) => (b.launchTime?.getTime() ?? 0) - (a.launchTime?.getTime() ?? 0));

                if (allInstances.length === 1 && allInstances[0]) {
                  const single = allInstances[0];
                  instanceId = single.id;
                  console.log('      Found single EC2 instance: ' + instanceId + ' (' + (single.ip ?? 'no public IP') + ')');
                } else if (allInstances.length > 1) {
                  // Auto-select newest instance with a public IP
                  const withIp = allInstances.filter(i => !!i.ip);
                  if (withIp.length > 0 && withIp[0]) {
                    instanceId = withIp[0].id;
                    console.log('      Found ' + allInstances.length + ' instances, using newest with public IP: ' + instanceId + ' (' + withIp[0].ip + ')');
                  } else {
                    console.log('      Multiple EC2 instances found but none have public IPs:');
                    for (const inst of allInstances) {
                      console.log('        - ' + inst.id + ' ' + (inst.ip ?? '') + ' ' + (inst.name ?? ''));
                    }
                    console.log('      Set prod.domain in stack.yml to the correct IP.');
                  }
                }
              } catch {
                // continue
              }
            }

            if (!instanceId) {
              console.log('      [!] No EC2 instance found in region ' + region);
              console.log('      If you haven\'t provisioned yet, run: npx stack fix --prod');
              console.log('      This will create VPC, EC2, and other AWS resources.');
              console.log('');
              // Still create a local key for future use — will be authorized after EC2 is provisioned
              console.log('      Creating SSH key for future use...');
              const localKeyProjName = getStackProjectName(config);
              const localKeyDir = getStackSshDir(localKeyProjName);
              if (!fs.existsSync(localKeyDir)) {
                fs.mkdirSync(localKeyDir, { recursive: true, mode: 0o700 });
              }
              const localKeyPath = getStackSshKeyPath(localKeyProjName, 'prod');
              if (!fs.existsSync(localKeyPath)) {
                try {
                  execSync('ssh-keygen -t ed25519 -f "' + localKeyPath + '" -N "" -C "prod-deploy"', { stdio: 'pipe' });
                  writeSecureKeyFile(localKeyPath, fs.readFileSync(localKeyPath, 'utf8'));
                } catch {
                  return false;
                }
              }
              const privKey = fs.readFileSync(localKeyPath, 'utf8');
              const vaultResult = await store.setSecret('PROD_SSH', privKey);
              if (vaultResult.success) {
                writeSshKeyToDisk('prod', privKey, config);
                console.log('      [OK] Stored PROD_SSH in vault (key will be authorized after EC2 provisioning)');
                return true;
              }
              return false;
            }

            // Instance found — get its details
            const instDesc = await ec2.send(new DescribeInstancesCommand({
              InstanceIds: [instanceId],
            }));
            const instance = instDesc.Reservations?.[0]?.Instances?.[0];
            const az = instance?.Placement?.AvailabilityZone;
            // Get public IP (prefer Elastic IP)
            let publicIp = (await findInstancePublicIp(projectName, region)) ?? undefined;
            if (!publicIp && instance?.InstanceId) {
              publicIp = (await findElasticIp(instance.InstanceId, region)) ?? instance?.PublicIpAddress ?? undefined;
            }

            if (!publicIp || !az) {
              console.log('      [!] Instance has no public IP or AZ. Is it running?');
              return false;
            }

            const sshUser = extractEnvironments(config).prod?.ssh_user ?? 'ubuntu';

            // Generate local SSH key if needed
            const instanceKeyProjName = getStackProjectName(config);
            const instanceKeyDir = getStackSshDir(instanceKeyProjName);
            if (!fs.existsSync(instanceKeyDir)) {
              fs.mkdirSync(instanceKeyDir, { recursive: true, mode: 0o700 });
            }
            const localKeyPath = getStackSshKeyPath(instanceKeyProjName, 'prod');
            const localPubPath = localKeyPath + '.pub';
            if (!fs.existsSync(localKeyPath)) {
              console.log('      [1/4] Generating SSH key...');
              try {
                execSync('ssh-keygen -t ed25519 -f "' + localKeyPath + '" -N "" -C "prod-deploy"', { stdio: 'pipe' });
                writeSecureKeyFile(localKeyPath, fs.readFileSync(localKeyPath, 'utf8'));
                console.log('      [OK] Generated: ' + localKeyPath);
              } catch (e) {
                console.log('      [!] ssh-keygen failed: ' + (e instanceof Error ? e.message : String(e)));
                return false;
              }
            } else {
              console.log('      [1/4] SSH key exists: ' + localKeyPath);
              // Test if key already works
              if (testSshKey(localKeyPath, sshUser, publicIp)) {
                console.log('      [OK] Key already authorized!');
                return await storeKeyInVault('prod', localKeyPath, config, store);
              }
              // Regenerate .pub if missing
              if (!fs.existsSync(localPubPath)) {
                try {
                  const pubResult = spawnSync('ssh-keygen', ['-y', '-f', localKeyPath], { encoding: 'utf8', stdio: 'pipe' });
                  if (pubResult.status === 0 && pubResult.stdout) { fs.writeFileSync(localPubPath, pubResult.stdout); }
                  else { throw new Error('ssh-keygen failed'); }
                } catch {
                  console.log('      [!] Could not regenerate .pub file');
                  return false;
                }
              }
            }

            // Push key via EC2 Instance Connect and add permanently
            const pubKey = fs.readFileSync(localPubPath, 'utf8').trim();
            console.log('      [2/4] Pushing key via EC2 Instance Connect...');

            const eicClient = getEC2ICClient(region);
            const sendResult = await eicClient.send(new SendSSHPublicKeyCommand({
              InstanceId: instanceId,
              InstanceOSUser: sshUser,
              SSHPublicKey: pubKey,
              AvailabilityZone: az,
            }));

            if (!sendResult.Success) {
              console.log('      [!] EC2 Instance Connect push failed');
              console.log('      Ensure ec2-instance-connect agent is installed on the instance.');
              return false;
            }
            console.log('      [OK] Temporary key pushed (60s window)');

            // Add key permanently to authorized_keys
            console.log('      [3/4] Adding key permanently...');
            const addKeyCmd = 'mkdir -p ~/.ssh && echo "' + pubKey + '" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && chmod 700 ~/.ssh && sort -u -o ~/.ssh/authorized_keys ~/.ssh/authorized_keys && echo ok';
            const addResult = spawnSync('ssh', [
              '-i', localKeyPath,
              '-o', 'StrictHostKeyChecking=no',
              '-o', 'ConnectTimeout=15',
              sshUser + '@' + publicIp,
              addKeyCmd,
            ], {
              encoding: 'utf8',
              stdio: 'pipe',
              timeout: 30000,
            });

            if (addResult.status !== 0) {
              console.log('      [!] Failed to add key permanently via ' + publicIp);
              if (addResult.stderr) console.log('      ' + addResult.stderr.trim().split('\n')[0]);
              // Still store the key in vault — it will work once the instance is reachable
              // (e.g., security group needs SSH port opened, or instance needs restart)
              console.log('      Storing key in vault anyway (will retry SSH on next run)...');
              const partialStore = await storeKeyInVault('prod', localKeyPath, config, store);
              if (partialStore) {
                // Update stack.yml with the EC2 IP if domain is EXAMPLE or missing
                const envs2 = extractEnvironments(config);
                const prodDomain2 = envs2.prod?.domain;
                if (!prodDomain2 || prodDomain2.toUpperCase().startsWith('EXAMPLE')) {
                  try {
                    const { updateConfigValue } = await import('../../../../utils/config-writer.js');
                    updateConfigValue(rootDir || process.cwd(), 'prod.domain', publicIp);
                    updateConfigValue(rootDir || process.cwd(), 'prod.ssh_user', sshUser);
                    console.log('      [OK] Updated stack.yml: prod.domain = ' + publicIp);
                  } catch { /* non-fatal */ }
                }
                console.log('      [OK] Key stored. Run "npx stack fix" again after instance is reachable.');
              }
              return partialStore;
            }
            console.log('      [OK] Key added permanently via ' + publicIp);

            // Verify
            if (!testSshKey(localKeyPath, sshUser, publicIp)) {
              console.log('      [!] Key verification failed');
              return false;
            }

            // Store in vault
            console.log('      [4/4] Storing in vault...');
            const stored = await storeKeyInVault('prod', localKeyPath, config, store);

            // Update stack.yml with the EC2 IP if domain is EXAMPLE or missing
            if (stored) {
              const environments = extractEnvironments(config);
              const prodDomain = environments.prod?.domain;
              if (!prodDomain || prodDomain.toUpperCase().startsWith('EXAMPLE')) {
                try {
                  const { updateConfigValue } = await import('../../../../utils/config-writer.js');
                  const dir = rootDir || process.cwd();
                  updateConfigValue(dir, 'prod.domain', publicIp);
                  updateConfigValue(dir, 'prod.ssh_user', sshUser);
                  console.log('      [OK] Updated stack.yml: prod.domain = ' + publicIp);
                } catch {
                  // non-fatal
                }
              }
            }
            return stored;
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

        // Fallback: auto-generate key (non-AWS projects)
        console.log('      Auto-generating and deploying a new SSH key...');
        return await autoGenerateAndDeploySshKey('prod', config, rootDir, store);
      } catch (e) {
        console.log('      [!] Error: ' + (e instanceof Error ? e.message : String(e)));
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
    stage: 'dev',
    severity: 'warning',
    description: '🔑 STAGING_SSH_PASSWORD not in vault (needed if staging uses password auth)',
    targetStage: 'staging', // Only run when targeting staging deployment
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      if (process.env.FACTIII_ON_SERVER === 'true' || process.env.GITHUB_ACTIONS === 'true') return false;
      const environments = extractEnvironments(config);
      if (!environments.staging) return false;

      // Only flag if there's NO SSH key — password is the fallback
      try {
        const stagingKeyPath = getStackSshKeyPath(getStackProjectName(config), 'staging');
        if (fs.existsSync(stagingKeyPath)) return false;
      } catch {
        // project name not set — skip key-exists check
      }

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
      try {
        const stagingKeyPath = getStackSshKeyPath(getStackProjectName(config), 'staging');
        if (fs.existsSync(stagingKeyPath)) {
          console.log('      SSH key now exists — password not needed');
          return true;
        }
      } catch {
        // project name not set — skip key-exists check
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
    stage: 'dev',
    severity: 'warning',
    description: '🔑 PROD_SSH_PASSWORD not in vault (needed if prod uses password auth)',
    targetStage: 'prod', // Only run when targeting prod deployment
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      if (process.env.FACTIII_ON_SERVER === 'true' || process.env.GITHUB_ACTIONS === 'true') return false;
      const environments = extractEnvironments(config);
      if (!environments.prod) return false;

      // Only flag if there's NO SSH key — password is the fallback
      try {
        const prodKeyPath = getStackSshKeyPath(getStackProjectName(config), 'prod');
        if (fs.existsSync(prodKeyPath)) return false;
      } catch {
        // project name not set — skip key-exists check
      }

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
      try {
        const prodKeyPath = getStackSshKeyPath(getStackProjectName(config), 'prod');
        if (fs.existsSync(prodKeyPath)) {
          console.log('      SSH key now exists — password not needed');
          return true;
        }
      } catch {
        // project name not set — skip key-exists check
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
    stage: 'dev',
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
        // Try reading from in-memory credentials cache first
        let secretFromMemory: string | null = null;
        try {
          const { getLoadedCredentials } = await import('../../aws/utils/aws-helpers.js');
          secretFromMemory = getLoadedCredentials().secretAccessKey;
        } catch { /* not loaded */ }

        if (secretFromMemory) {
          const result = await store.setSecret('AWS_SECRET_ACCESS_KEY', secretFromMemory);
          if (result.success) {
            console.log('   Stored AWS_SECRET_ACCESS_KEY in Ansible Vault');
            return true;
          }
        }

        // Fall back to interactive prompt
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
    stage: 'dev',
    severity: 'critical',
    description: '🔑 STAGING_SSH key file not on disk (required for staging access)',
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
          console.log('      STAGING_SSH not in vault — paste it now to store and write to disk.');
          const wantPaste = await confirm('      Paste your staging SSH key now?', true);
          if (wantPaste) {
            return await manualSshKeyEntry('staging', config, store);
          }
          console.log('      Skipped. Run `npx stack fix --secrets` again when ready.');
          return false;
        }

        const keyPath = writeSshKeyToDisk('staging', key, config);
        console.log('      Wrote STAGING_SSH → ' + keyPath);

        // Test if the key is authorized on the staging server
        const environments = extractEnvironments(config);
        const stagingEnv = environments.staging;
        if (stagingEnv?.domain && stagingEnv?.ssh_user) {
          const host = stagingEnv.domain as string;
          const user = stagingEnv.ssh_user as string;

          if (!testSshKey(keyPath, user, host)) {
            console.log('      [!] Key written but not authorized on ' + host);
            console.log('      Attempting EC2 Instance Connect to authorize key...');

            const pubKeyPath = keyPath + '.pub';
            try {
              const kgResult = spawnSync('ssh-keygen', ['-y', '-f', keyPath], { encoding: 'utf8', stdio: 'pipe' });
              if (kgResult.status === 0 && kgResult.stdout) { fs.writeFileSync(pubKeyPath, kgResult.stdout); }
              else { throw new Error('ssh-keygen failed'); }
            } catch {
              console.log('      [!] Could not generate public key from private key');
              return true;
            }

            const eicResult = await tryEc2InstanceConnect(keyPath, pubKeyPath, user, host, config);
            if (eicResult.added) {
              console.log('      [OK] Key authorized on ' + (eicResult.connectedHost ?? host));
            } else {
              console.log('      [!] Could not auto-authorize key on ' + host);
              console.log('      You may need to manually run: ssh-copy-id -i ' + keyPath + ' ' + user + '@' + host);
            }
          } else {
            console.log('      [OK] Key verified on ' + host);
          }
        }

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
    stage: 'dev',
    severity: 'critical',
    description: '🔑 PROD_SSH key file not on disk (required for prod access)',
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
          console.log('      PROD_SSH not in vault — paste it now to store and write to disk.');
          const wantPaste = await confirm('      Paste your prod SSH key now?', true);
          if (wantPaste) {
            return await manualSshKeyEntry('prod', config, store);
          }
          console.log('      Skipped. Run `npx stack fix --secrets` again when ready.');
          return false;
        }

        const keyPath = writeSshKeyToDisk('prod', key, config);
        console.log('      Wrote PROD_SSH → ' + keyPath);

        // Test if the key is authorized on the prod server
        const environments = extractEnvironments(config);
        const prodEnv = environments.prod;
        if (prodEnv?.domain && prodEnv?.ssh_user) {
          const host = prodEnv.domain as string;
          const user = prodEnv.ssh_user as string;

          if (!testSshKey(keyPath, user, host)) {
            console.log('      [!] Key written but not authorized on ' + host);
            console.log('      Attempting EC2 Instance Connect to authorize key...');

            // Regenerate .pub file for EC2 Instance Connect
            const pubKeyPath = keyPath + '.pub';
            try {
              const kgResult = spawnSync('ssh-keygen', ['-y', '-f', keyPath], { encoding: 'utf8', stdio: 'pipe' });
              if (kgResult.status === 0 && kgResult.stdout) { fs.writeFileSync(pubKeyPath, kgResult.stdout); }
              else { throw new Error('ssh-keygen failed'); }
            } catch {
              console.log('      [!] Could not generate public key from private key');
              return true; // Key is on disk, just not authorized yet
            }

            const eicResult = await tryEc2InstanceConnect(keyPath, pubKeyPath, user, host, config);
            if (eicResult.added) {
              console.log('      [OK] Key authorized on ' + (eicResult.connectedHost ?? host));
            } else {
              console.log('      [!] Could not auto-authorize key on ' + host);
              console.log('      You may need to manually run: ssh-copy-id -i ' + keyPath + ' ' + user + '@' + host);
            }
          } else {
            console.log('      [OK] Key verified on ' + host);
          }
        }

        return true;
      } catch {
        return false;
      }
    },
    manualFix:
      'Extract SSH keys from vault: npx stack deploy --secrets write-ssh-keys',
  },
];
