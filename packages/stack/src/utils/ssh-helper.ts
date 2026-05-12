/**
 * SSH Helper Utility
 *
 * Shared SSH execution logic for pipeline and server plugins.
 * Provides a consistent way to execute commands on remote servers.
 *
 * Auth priority:
 * 1. SSH key: ~/.ssh/{stage}_deploy_key (from Ansible Vault via write-ssh-keys)
 * 2. Password: {STAGE}_SSH_PASSWORD from Ansible Vault (uses sshpass)
 */
import { execSync, spawnSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import yaml from 'js-yaml';
import type { EnvironmentConfig, FactiiiConfig, Stage } from '../types/index.js';
import { extractEnvironments, getStageFromEnvironment } from './config-helpers.js';
import { promptSingleLine } from './secret-prompts.js';
import { AnsibleVaultSecrets } from './ansible-vault-secrets.js';
import { getStackSshDir, getStackSshKeyPath } from './ssh-paths.js';
import { getStackProjectName } from './project-identifier.js';

/**
 * Write an SSH key to a file with correct permissions (cross-platform).
 * On Windows, uses icacls to restrict access since POSIX modes are ignored.
 */
export function writeSecureKeyFile(keyPath: string, keyContent: string): void {
  fs.writeFileSync(keyPath, keyContent, { mode: 0o600 });
  if (process.platform === 'win32') {
    try {
      execSync('icacls "' + keyPath + '" /inheritance:r /grant:r "%USERNAME%:F" 2>nul', {
        stdio: 'pipe',
        windowsHide: true,
      });
    } catch { /* best effort */ }
  }
}

/**
 * Find the SSH key path for a given stage under ~/.ssh/factiii/<project>/.
 * Returns null if the key doesn't exist or isn't a valid private key.
 */
export function findSshKeyForStage(stage: string, projectName: string): string | null {
  if (stage === 'prod') {
    // Prod can use either {stage}_deploy_key or a .pem (EC2 key pair).
    // The .pem path comes from config — caller passes it via findProdPemKey instead.
    // findSshKeyForStage just checks the deploy_key path.
  }
  const keyPath = getStackSshKeyPath(projectName, stage);
  if (!fs.existsSync(keyPath)) return null;
  try {
    const content = fs.readFileSync(keyPath, 'utf8');
    if (!content.includes('PRIVATE KEY')) return null;
    return keyPath;
  } catch {
    return null;
  }
}

/**
 * For prod, an explicit .pem path may be configured in stack.yml (aws.prod_ssh_key_path).
 * Returns the path if it exists and is a valid private key, else null.
 */
export function findProdPemKey(config: FactiiiConfig): string | null {
  const projectName = getStackProjectName(config);
  const configured = config.aws?.prod_ssh_key_path;
  const pemPath = configured
    ? configured.replace(/^~/, os.homedir())
    : path.join(getStackSshDir(projectName), 'prod.pem');
  if (!fs.existsSync(pemPath)) return null;
  try {
    const content = fs.readFileSync(pemPath, 'utf8');
    if (!content.includes('PRIVATE KEY')) return null;
    return pemPath;
  } catch {
    return null;
  }
}

/**
 * Get the EnvironmentConfig for a given stage from stack.yml config.
 * Returns the first environment matching the stage.
 *
 * @param stage - The deployment stage (staging, prod)
 * @param config - Parsed stack.yml config
 * @returns EnvironmentConfig with domain and ssh_user, or null
 */
export function getEnvConfigForStage(
  stage: Stage,
  config: FactiiiConfig
): EnvironmentConfig | null {
  const environments = extractEnvironments(config);

  for (const [envName, envConfig] of Object.entries(environments)) {
    try {
      if (getStageFromEnvironment(envName) === stage) {
        return envConfig;
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Look up {STAGE}_SSH_PASSWORD from Ansible Vault.
 * Returns null if vault not configured or password not stored.
 */
async function getSshPasswordFromVault(stage: string, config: FactiiiConfig, rootDir?: string): Promise<string | null> {
  if (!config.ansible?.vault_path) return null;

  try {
    const secretName = stage.toUpperCase() + '_SSH_PASSWORD';
    const vaultPath = config.ansible.vault_path;
    const resolvedPath = path.isAbsolute(vaultPath)
      ? vaultPath
      : path.join(rootDir ?? process.cwd(), vaultPath);

    if (!fs.existsSync(resolvedPath)) return null;

    // Decrypt vault using pure Node.js (no CLI)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Vault } = require('ansible-vault') as { Vault: new (opts: { password: string }) => { decryptSync: (data: string) => string } };
    const { getVaultPasswordString } = await import('./ansible-vault-secrets.js');

    const password = await getVaultPasswordString({
      vault_path: config.ansible.vault_path,
      vault_password_file: config.ansible.vault_password_file,
      rootDir: rootDir ?? process.cwd(),
    });

    const vaultContent = fs.readFileSync(resolvedPath, 'utf8');
    const v = new Vault({ password });
    const content = v.decryptSync(vaultContent);

    const parsed = yaml.load(content) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed[secretName];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Prompt user for SSH password, test it, and store in Ansible Vault if valid.
 * Returns the password on success, null on failure.
 */
/**
 * Store password in Ansible Vault and return it.
 * Used as fallback when SSH key setup fails — the password is still valid.
 */
async function storePasswordAndReturn(
  password: string,
  stage: string,
  config: FactiiiConfig,
  rootDir?: string
): Promise<string> {
  const secretName = stage.toUpperCase() + '_SSH_PASSWORD';
  if (config.ansible?.vault_path) {
    try {
      const store = new AnsibleVaultSecrets({
        vault_path: config.ansible.vault_path,
        vault_password_file: config.ansible.vault_password_file,
        rootDir: rootDir ?? process.cwd(),
      });
      const result = await store.setSecret(secretName, password);
      if (result.success) {
        console.log('   [OK] Password stored in Ansible Vault as ' + secretName);
      }
    } catch { /* best effort */ }
  }
  return password;
}

/**
 * Auto-generate SSH key, copy to server via ssh-copy-id, and store in vault.
 * Returns the key path on success, null on failure.
 */
async function autoSetupSshKey(
  stage: string,
  host: string,
  user: string,
  config?: FactiiiConfig,
  rootDir?: string
): Promise<string | null> {
  if (!config) return null;
  const projectName = getStackProjectName(config);
  const keyPath = getStackSshKeyPath(projectName, stage);
  const pubKeyPath = keyPath + '.pub';
  fs.mkdirSync(getStackSshDir(projectName), { recursive: true, mode: 0o700 });

  console.log('');
  console.log('   ── Auto SSH Key Setup ──');

  // Validate existing key pair
  let needsGeneration = !fs.existsSync(keyPath);
  if (!needsGeneration && fs.existsSync(pubKeyPath)) {
    try {
      const derivedPub = execSync(
        'ssh-keygen -y -f "' + keyPath + '"',
        { encoding: 'utf8', stdio: 'pipe' }
      ).trim().split(' ').slice(0, 2).join(' ');
      const storedPub = fs.readFileSync(pubKeyPath, 'utf8').trim().split(' ').slice(0, 2).join(' ');
      if (derivedPub !== storedPub) {
        console.log('   [!] Key pair mismatched — regenerating...');
        try { fs.unlinkSync(keyPath); } catch { /* ok */ }
        try { fs.unlinkSync(pubKeyPath); } catch { /* ok */ }
        needsGeneration = true;
      }
    } catch {
      try { fs.unlinkSync(keyPath); } catch { /* ok */ }
      try { fs.unlinkSync(pubKeyPath); } catch { /* ok */ }
      needsGeneration = true;
    }
  }

  if (needsGeneration) {
    console.log('   Generating SSH key...');
    try {
      execSync(
        'ssh-keygen -t ed25519 -f "' + keyPath + '" -N "" -C "' + stage + '-deploy"',
        { stdio: 'pipe' }
      );
      try { fs.chmodSync(keyPath, 0o600); } catch { /* Windows */ }
      console.log('   [OK] Generated: ' + keyPath);
    } catch (e) {
      console.log('   [!] ssh-keygen failed: ' + (e instanceof Error ? e.message : String(e)));
      return null;
    }
  }

  // Copy public key to server
  console.log('   Copying public key to ' + user + '@' + host + '...');

  if (process.platform === 'win32') {
    // Windows: ssh-copy-id is not available — use SSH to pipe the public key
    console.log('   Enter password when prompted by SSH:');
    console.log('');
    try {
      const pubKeyContent = fs.readFileSync(pubKeyPath, 'utf8').trim();
      const addKeyCmd = 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo "' + pubKeyContent + '" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && sort -u -o ~/.ssh/authorized_keys ~/.ssh/authorized_keys';
      const copyResult = spawnSync('ssh', [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=10',
        user + '@' + host,
        addKeyCmd,
      ], {
        stdio: 'inherit',
        timeout: 60000,
      });
      if (copyResult.status !== 0) {
        console.log('   [!] Failed to copy public key to server');
        return null;
      }
    } catch (e) {
      console.log('   [!] Failed to copy public key: ' + (e instanceof Error ? e.message : String(e)));
      return null;
    }
  } else {
    // Linux/Mac: use ssh-copy-id
    console.log('   Enter password when prompted:');
    console.log('');
    try {
      const copyResult = spawnSync('ssh-copy-id', [
        '-i', pubKeyPath,
        '-o', 'StrictHostKeyChecking=no',
        user + '@' + host,
      ], {
        stdio: 'inherit',
        timeout: 60000,
      });
      if (copyResult.status !== 0) {
        console.log('   [!] ssh-copy-id failed');
        return null;
      }
    } catch (e) {
      console.log('   [!] ssh-copy-id failed: ' + (e instanceof Error ? e.message : String(e)));
      return null;
    }
  }

  // Fix remote permissions using the key we just copied (avoid extra password prompt)
  try {
    spawnSync('ssh', [
      '-i', keyPath,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=5',
      user + '@' + host,
      'chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys',
    ], { encoding: 'utf8', stdio: 'pipe', timeout: 15000 });
  } catch { /* best effort */ }

  // Verify key auth
  const verifyResult = spawnSync('ssh', [
    '-i', keyPath,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=5',
    user + '@' + host,
    'echo ok',
  ], { encoding: 'utf8', stdio: 'pipe', timeout: 15000 });

  if (verifyResult.status !== 0) {
    console.log('   [!] Key verification failed — server may not allow PubkeyAuthentication');
    return null;
  }

  console.log('   [OK] SSH key auth working');

  // Store in vault
  if (config?.ansible?.vault_path) {
    try {
      const privateKey = fs.readFileSync(keyPath, 'utf8');
      const sshSecretName = stage.toUpperCase() + '_SSH';
      const store = new AnsibleVaultSecrets({
        vault_path: config.ansible.vault_path,
        vault_password_file: config.ansible.vault_password_file,
        rootDir: rootDir ?? process.cwd(),
      });
      const storeResult = await store.setSecret(sshSecretName, privateKey);
      if (storeResult.success) {
        console.log('   [OK] Key stored in vault as ' + sshSecretName);
      }
    } catch { /* optional */ }
  }

  console.log('');
  return keyPath;
}

async function promptAndValidatePassword(
  stage: string,
  host: string,
  user: string,
  config: FactiiiConfig,
  rootDir?: string
): Promise<string | null> {
  // Vault must be configured to store the password
  if (!config.ansible?.vault_path) {
    console.log('   [!] Cannot prompt for password — ansible.vault_path not configured');
    return null;
  }

  console.log('');
  console.log('   No SSH key or stored password for ' + stage + '.');

  const password = await promptSingleLine('   Enter SSH password for ' + user + '@' + host + ': ', { hidden: true });
  if (!password) {
    console.log('   [!] No password entered');
    return null;
  }

  // Test the connection with sshpass (only available on Linux/Mac)
  if (process.platform !== 'win32') {
    console.log('   Testing SSH connection...');
    const testResult = spawnSync('sshpass', [
      '-p', password,
      'ssh',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=5',
      user + '@' + host,
      'echo ok',
    ], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 15000,
    });

    if (testResult.status === 5) {
      // sshpass exit code 5 = wrong password
      console.log('   [!] Incorrect password.');
      return null;
    }

    if (testResult.status !== 0) {
      // sshpass failed — likely keyboard-interactive auth (Mac servers)
      // Fall back to auto SSH key setup so we never need sshpass again
      console.log('   [!] Password auth via sshpass failed (server may use keyboard-interactive auth).');
      console.log('   Setting up SSH key auth instead...');
      console.log('');

      if (!config) return null;
      const projectName = getStackProjectName(config);
      const keyPath = getStackSshKeyPath(projectName, stage);
      const pubKeyPath = keyPath + '.pub';
      fs.mkdirSync(getStackSshDir(projectName), { recursive: true, mode: 0o700 });

      // Step 1: Generate key (delete and regenerate if key pair is mismatched)
      let needsGeneration = !fs.existsSync(keyPath);

      if (!needsGeneration && fs.existsSync(pubKeyPath)) {
        // Validate existing key pair matches
        try {
          const derivedPub = execSync(
            'ssh-keygen -y -f "' + keyPath + '"',
            { encoding: 'utf8', stdio: 'pipe' }
          ).trim();
          const storedPub = fs.readFileSync(pubKeyPath, 'utf8').trim().split(' ').slice(0, 2).join(' ');
          const derivedPubShort = derivedPub.split(' ').slice(0, 2).join(' ');
          if (derivedPubShort !== storedPub) {
            console.log('   [!] Existing key pair is mismatched — regenerating...');
            try { fs.unlinkSync(keyPath); } catch { /* ok */ }
            try { fs.unlinkSync(pubKeyPath); } catch { /* ok */ }
            needsGeneration = true;
          }
        } catch {
          // ssh-keygen failed to read key — likely corrupted
          console.log('   [!] Existing key is corrupted — regenerating...');
          try { fs.unlinkSync(keyPath); } catch { /* ok */ }
          try { fs.unlinkSync(pubKeyPath); } catch { /* ok */ }
          needsGeneration = true;
        }
      }

      if (needsGeneration) {
        console.log('   [1/4] Generating SSH key...');
        try {
          execSync(
            'ssh-keygen -t ed25519 -f "' + keyPath + '" -N "" -C "' + stage + '-deploy"',
            { stdio: 'pipe' }
          );
          // Fix permissions
          try { fs.chmodSync(keyPath, 0o600); } catch { /* Windows */ }
          console.log('   [OK] Generated: ' + keyPath);
        } catch (e) {
          console.log('   [!] ssh-keygen failed: ' + (e instanceof Error ? e.message : String(e)));
          return await storePasswordAndReturn(password, stage, config, rootDir);
        }
      } else {
        console.log('   [1/4] SSH key already exists: ' + keyPath);
      }
      // Step 2: Copy public key to server (user types password interactively)
      console.log('   Copying public key to server...');
      console.log('   You will be prompted for the password for ' + user + '@' + host);
      console.log('');
      try {
        const copyResult = spawnSync('ssh-copy-id', [
          '-i', pubKeyPath,
          '-o', 'StrictHostKeyChecking=no',
          user + '@' + host,
        ], {
          stdio: 'inherit',
          timeout: 60000,
        });

        if (copyResult.status !== 0) {
          console.log('   [!] ssh-copy-id failed');
          return null;
        }
        console.log('   [OK] Public key copied to server');
      } catch (e) {
        console.log('   [!] ssh-copy-id failed: ' + (e instanceof Error ? e.message : String(e)));
        // Store password in vault anyway so sshExec can try it
        return await storePasswordAndReturn(password, stage, config, rootDir);
      }

      // Step 2.5: Fix remote permissions using the key we just copied (avoid extra password prompt)
      console.log('   Fixing remote SSH permissions...');
      try {
        spawnSync('ssh', [
          '-i', keyPath,
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'ConnectTimeout=5',
          user + '@' + host,
          'chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys',
        ], {
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 15000,
        });
      } catch { /* best effort */ }

      // Step 3: Verify key auth works
      console.log('   Verifying SSH key auth...');
      const verifyResult = spawnSync('ssh', [
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

      if (verifyResult.status !== 0) {
        const sshErr = (verifyResult.stderr ?? '').trim();
        console.log('   [!] Key auth verification failed' + (sshErr ? ': ' + sshErr : ''));
        console.log('   The key was copied but the server may need PubkeyAuthentication enabled.');
        console.log('   On the server, check: sudo grep PubkeyAuthentication /etc/ssh/sshd_config');
        console.log('   Storing password so the connection can proceed...');
        // Store password in vault so subsequent SSH commands can use it
        return await storePasswordAndReturn(password, stage, config, rootDir);
      }
      console.log('   [OK] SSH key auth verified — no password needed going forward');

      // Step 4: Store the key in vault
      if (config.ansible?.vault_path) {
        try {
          const privateKey = fs.readFileSync(keyPath, 'utf8');
          const sshSecretName = stage.toUpperCase() + '_SSH';
          const store = new AnsibleVaultSecrets({
            vault_path: config.ansible.vault_path,
            vault_password_file: config.ansible.vault_password_file,
            rootDir: rootDir ?? process.cwd(),
          });
          const storeResult = await store.setSecret(sshSecretName, privateKey);
          if (storeResult.success) {
            console.log('   [OK] SSH key stored in Ansible Vault as ' + sshSecretName);
          }
        } catch { /* vault store is optional */ }
      }

      // Return password so caller can proceed (key is now set up for future)
      return password;
    }
  }

  // Password works — store in Ansible Vault
  const secretName = stage.toUpperCase() + '_SSH_PASSWORD';
  try {
    const store = new AnsibleVaultSecrets({
      vault_path: config.ansible.vault_path,
      vault_password_file: config.ansible.vault_password_file,
      rootDir: rootDir ?? process.cwd(),
    });

    const result = await store.setSecret(secretName, password);
    if (result.success) {
      console.log('   [OK] Password stored in Ansible Vault as ' + secretName);
      console.log('        Next time, it will be used automatically.');
    } else {
      console.log('   [!] Password works but failed to store in vault: ' + (result.error ?? 'unknown error'));
      console.log('        You will be prompted again next time.');
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log('   [!] Password works but failed to store in vault: ' + msg);
  }

  return password;
}

/**
 * Execute a command on a remote server via SSH
 * Falls back to sshpass with vault password when no SSH key exists.
 *
 * @param envConfig - Environment config with host and ssh_user
 * @param command - Command to execute
 * @param stage - Optional stage to use the correct SSH key (staging, prod)
 * @param config - Optional stack.yml config (needed for vault password fallback)
 * @param rootDir - Optional project root directory (for vault path resolution)
 * @returns Command output
 */
export async function sshExec(
  envConfig: EnvironmentConfig,
  command: string,
  stage?: Stage,
  config?: FactiiiConfig,
  rootDir?: string
): Promise<string> {
  // ============================================================
  // CRITICAL: Detect if we're already on the server
  // ============================================================
  // When GITHUB_ACTIONS=true or FACTIII_ON_SERVER=true, we're executing
  // on the server itself. Run commands locally instead of trying to SSH.
  // ============================================================
  if (process.env.GITHUB_ACTIONS === 'true' || process.env.FACTIII_ON_SERVER === 'true') {
    // We're already on the server - run command locally
    const result = execSync(command, { encoding: 'utf8', stdio: 'pipe' });
    return result.trim();
  }

  // Running from dev machine - SSH to server
  const host = envConfig.domain;
  const user = envConfig.ssh_user ?? 'ubuntu';

  // Use stage-specific key if stage is provided (repo-aware)
  let keyPath: string | null = null;
  const sshProjectName = config?.name;
  if (stage && sshProjectName) {
    keyPath = findSshKeyForStage(stage, sshProjectName);
  }

  // Fallback: try all known deploy keys across all stages for this project
  if (!keyPath && sshProjectName) {
    const fallbackStages = ['staging', 'prod', 'mac'];
    const seen = new Set<string>();

    for (const s of fallbackStages) {
      const kp = getStackSshKeyPath(sshProjectName, s);
      if (seen.has(kp)) continue;
      seen.add(kp);
      if (fs.existsSync(kp)) {
        keyPath = kp;
        break;
      }
    }
  }

  // No SSH key — try password from vault, then prompt user
  if (!keyPath) {
    let password: string | null = null;

    if (config && stage) {
      password = await getSshPasswordFromVault(stage, config, rootDir);

      // No stored password — prompt user, validate, and store
      if (!password) {
        password = await promptAndValidatePassword(stage, host as string, user, config, rootDir);
      }
    }

    if (password) {
      if (process.platform === 'win32') {
        // Windows: no sshpass — use interactive SSH (stdio: 'inherit' so user can type password)
        const result = spawnSync('ssh', [
          '-tt',
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'ConnectTimeout=10',
          '-o', 'ServerAliveInterval=60',
          '-o', 'ServerAliveCountMax=5',
          user + '@' + host,
          command,
        ], {
          encoding: 'utf8',
          stdio: 'inherit',
        });

        if (result.status !== 0) {
          throw new Error('SSH command failed with exit code ' + result.status);
        }

        return '';
      }

      // Linux/Mac: use sshpass
      const result = spawnSync('sshpass', [
        '-p', password,
        'ssh',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=60',
        '-o', 'ServerAliveCountMax=5',
        user + '@' + host,
        command,
      ], {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      if (result.status !== 0) {
        throw new Error(result.stderr || 'SSH (password) command failed with exit code ' + result.status);
      }

      return (result.stdout ?? '').trim();
    }

    throw new Error(
      'No SSH key found. Add a deploy key to ~/.ssh/ or store password: npx stack fix --secrets'
    );
  }

  const result = spawnSync('ssh', [
    '-i', keyPath,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=60',
    '-o', 'ServerAliveCountMax=5',
    user + '@' + host,
    command,
  ], {
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (result.status !== 0) {
    // Check if it's an auth failure on an AWS EC2 instance — try EC2 Instance Connect recovery
    const errMsg = result.stderr ?? '';
    if (errMsg.includes('Permission denied') && config?.aws && stage === 'prod') {
      try {
        const { isAwsConfigured, getAwsConfig, getProjectName, findInstance, findInstancePublicIp,
          getEC2Client, getEC2ICClient, DescribeInstancesCommand, SendSSHPublicKeyCommand } =
          await import('../plugins/pipelines/aws/utils/aws-helpers.js');

        if (isAwsConfigured(config)) {
          const { region } = getAwsConfig(config);
          const projectName = getProjectName(config);

          // Find instance
          let instId = await findInstance(projectName, region);
          if (!instId) {
            const ec2 = getEC2Client(region);
            const kpDesc = await ec2.send(new DescribeInstancesCommand({
              Filters: [
                { Name: 'key-name', Values: ['factiii-' + projectName] },
                { Name: 'instance-state-name', Values: ['running'] },
              ],
            }));
            instId = kpDesc.Reservations?.[0]?.Instances?.[0]?.InstanceId ?? null;
          }

          if (instId) {
            const ec2 = getEC2Client(region);
            const instDesc = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instId] }));
            const inst = instDesc.Reservations?.[0]?.Instances?.[0];
            const az = inst?.Placement?.AvailabilityZone;
            const connectIp = (await findInstancePublicIp(projectName, region)) ?? inst?.PublicIpAddress;

            if (az && connectIp) {
              // Ensure .pub file exists
              const pubPath = keyPath + '.pub';
              if (!fs.existsSync(pubPath)) {
                try { execSync('ssh-keygen -y -f "' + keyPath + '" > "' + pubPath + '"', { stdio: 'pipe' }); } catch { /* */ }
              }
              if (fs.existsSync(pubPath)) {
                const pubKey = fs.readFileSync(pubPath, 'utf8').trim();
                const eic = getEC2ICClient(region);
                const pushResult = await eic.send(new SendSSHPublicKeyCommand({
                  InstanceId: instId, InstanceOSUser: user, SSHPublicKey: pubKey, AvailabilityZone: az,
                }));

                if (pushResult.Success) {
                  // Add key permanently
                  const addCmd = 'mkdir -p ~/.ssh && echo "' + pubKey + '" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && chmod 700 ~/.ssh && sort -u -o ~/.ssh/authorized_keys ~/.ssh/authorized_keys';
                  spawnSync('ssh', ['-i', keyPath, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=15', user + '@' + connectIp, addCmd],
                    { encoding: 'utf8', stdio: 'pipe', timeout: 30000 });

                  // Retry the original command
                  const retryHost = connectIp ?? host;
                  const retry = spawnSync('ssh', [
                    '-i', keyPath, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10',
                    '-o', 'ServerAliveInterval=60', '-o', 'ServerAliveCountMax=5',
                    user + '@' + retryHost, command,
                  ], { encoding: 'utf8', stdio: 'pipe' });

                  if (retry.status === 0) {
                    return (retry.stdout ?? '').trim();
                  }
                }
              }
            }
          }
        }
      } catch { /* EC2 IC recovery failed — fall through to original error */ }
    }

    throw new Error(result.stderr || 'SSH command failed with exit code ' + result.status);
  }

  return (result.stdout ?? '').trim();
}
