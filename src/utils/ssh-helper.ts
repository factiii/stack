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
 * Map of stage names to their environment-specific SSH key filenames.
 * These keys are extracted from Ansible Vault by `npx stack deploy --secrets write-ssh-keys`.
 */
const STAGE_KEY_MAP: Record<string, string[]> = {
  staging: ['staging_deploy_key'],
  prod: ['prod_deploy_key'],   // Only repo-specific deploy key; vault/pem handled separately
  mac: ['mac_deploy_key'],
};

/**
 * Scan ~/.ssh/ for any .pem files (AWS EC2 key pairs).
 * Returns the first .pem file found that contains a private key.
 */
function findPemKey(sshDir: string): string | null {
  try {
    const files = fs.readdirSync(sshDir);
    for (const file of files) {
      if (!file.endsWith('.pem')) continue;
      const keyPath = path.join(sshDir, file);
      try {
        const content = fs.readFileSync(keyPath, 'utf8');
        if (content.includes('PRIVATE KEY')) return keyPath;
      } catch { /* skip unreadable */ }
    }
  } catch { /* no .ssh dir */ }
  return null;
}

/**
 * Get the SSH key filename(s) for a stage, with optional repo-specific variant.
 * Returns repo-specific name first (e.g. `staging_deploy_key_factiii`),
 * then generic name (`staging_deploy_key`) for backward compatibility.
 *
 * @param stage - The deployment stage (staging, prod, mac)
 * @param repoName - Optional repo name for multi-repo key isolation
 * @returns Array of key names to try, most specific first
 */
export function getKeyNamesForStage(stage: string, repoName?: string): string[] {
  const genericKeys = STAGE_KEY_MAP[stage] ?? [];
  if (!repoName || repoName.toUpperCase().startsWith('EXAMPLE')) {
    return genericKeys;
  }

  // Repo-specific keys first, then generic fallback
  const repoKeys = genericKeys.map(k => k + '_' + repoName);
  return [...repoKeys, ...genericKeys];
}

/**
 * Find the SSH key path for a given stage.
 * Checks repo-specific keys first (e.g. staging_deploy_key_factiii),
 * then falls back to generic keys (staging_deploy_key).
 *
 * @param stage - The deployment stage (staging, prod, mac)
 * @param repoName - Optional repo name for multi-repo key isolation
 * @returns Absolute path to SSH key, or null if none found
 */
export function findSshKeyForStage(stage: string, repoName?: string): string | null {
  const sshDir = path.join(os.homedir(), '.ssh');

  const keyNames = getKeyNamesForStage(stage, repoName);
  for (const keyName of keyNames) {
    const keyPath = path.join(sshDir, keyName);
    if (fs.existsSync(keyPath)) {
      // Validate key file has actual private key content
      try {
        const content = fs.readFileSync(keyPath, 'utf8');
        if (!content.includes('PRIVATE KEY')) {
          console.log('   [!] ' + keyPath + ' exists but is not a valid private key — skipping');
          continue;
        }
      } catch {
        continue;
      }
      return keyPath;
    }
  }

  // For prod: also scan for .pem files (AWS EC2 key pairs)
  if (stage === 'prod') {
    const pemKey = findPemKey(sshDir);
    if (pemKey) return pemKey;
  }

  return null;
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
function getSshPasswordFromVault(stage: string, config: FactiiiConfig, rootDir?: string): string | null {
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
    const { getVaultPasswordString } = require('./ansible-vault-secrets.js') as { getVaultPasswordString: (config: { vault_path: string; vault_password_file?: string; rootDir?: string }) => string };

    const password = getVaultPasswordString({
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
  const keyName = stage + '_deploy_key';
  const keyPath = path.join(os.homedir(), '.ssh', keyName);
  const pubKeyPath = keyPath + '.pub';

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

  // Fix remote permissions
  try {
    spawnSync('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=5',
      user + '@' + host,
      'chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys',
    ], { stdio: 'inherit', timeout: 15000 });
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

    if (testResult.status !== 0) {
      // sshpass failed — likely keyboard-interactive auth (Mac servers)
      // Fall back to auto SSH key setup so we never need sshpass again
      console.log('   [!] Password auth via sshpass failed (server may use keyboard-interactive auth).');
      console.log('   Setting up SSH key auth instead...');
      console.log('');

      const keyName = stage + '_deploy_key';
      const keyPath = path.join(os.homedir(), '.ssh', keyName);
      const pubKeyPath = keyPath + '.pub';

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

      // Step 2.5: Fix remote permissions (common issue on Mac servers)
      console.log('   Fixing remote SSH permissions...');
      try {
        spawnSync('ssh', [
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'ConnectTimeout=5',
          user + '@' + host,
          'chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys',
        ], {
          stdio: 'inherit',
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
 * Execute a Factiii CLI command on a remote server via direct SSH.
 * Used by scan.ts, fix.ts, and deployStage() when canReach returns via: 'ssh'.
 *
 * Auth priority:
 * 1. SSH key file (~/.ssh/{stage}_deploy_key)
 * 2. Password from vault ({STAGE}_SSH_PASSWORD) via sshpass
 *
 * @param stage - Target stage (staging, prod)
 * @param config - Parsed stack.yml config
 * @param command - The factiii CLI command to run (e.g., 'scan --staging', 'fix --prod')
 * @param rootDir - Optional project root directory (for vault path resolution)
 * @returns Object with success, stdout, and stderr
 */
export async function sshRemoteFactiiiCommand(
  stage: Stage,
  config: FactiiiConfig,
  command: string,
  rootDir?: string
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const envConfig = getEnvConfigForStage(stage, config);
  if (!envConfig) {
    return {
      success: false,
      stdout: '',
      stderr: 'No environment config found for stage: ' + stage,
    };
  }

  const host = envConfig.domain;
  const user = envConfig.ssh_user ?? 'root';

  if (!host) {
    return {
      success: false,
      stdout: '',
      stderr: 'No domain configured for stage: ' + stage + '. Check stack.yml environments.',
    };
  }

  const repoName = config.name || 'app';
  const keyPath = findSshKeyForStage(stage, repoName);

  // Step 1: If no key on disk, try extracting PROD_SSH/STAGING_SSH from vault
  let resolvedKeyPath = keyPath;
  if (!resolvedKeyPath && config.ansible?.vault_path) {
    try {
      const store = new AnsibleVaultSecrets({
        vault_path: config.ansible.vault_path,
        vault_password_file: config.ansible.vault_password_file,
        rootDir: rootDir ?? process.cwd(),
      });
      const sshSecretName = stage.toUpperCase() + '_SSH';
      const privateKey = await store.getSecret(sshSecretName);
      if (privateKey && privateKey.includes('PRIVATE KEY')) {
        const keyDest = path.join(os.homedir(), '.ssh', stage + '_deploy_key');
        writeSecureKeyFile(keyDest, privateKey);
        console.log('   [OK] Extracted ' + sshSecretName + ' from vault → ' + keyDest);
        resolvedKeyPath = keyDest;
      }
    } catch { /* vault not configured or secret not found */ }
  }

  // Step 1.5: No key on disk or vault — try AWS EC2 Instance Connect to establish key access
  if (!resolvedKeyPath) {
    try {
      const { isAwsConfigured, getAwsConfig, getProjectName, findInstance, findInstancePublicIp, pushSshPublicKey } =
        await import('../plugins/pipelines/aws/utils/aws-helpers.js');

      if (isAwsConfigured(config)) {
        const { region } = getAwsConfig(config);
        const projectName = getProjectName(config);
        const instanceId = await findInstance(projectName, region);

        if (instanceId) {
          console.log('   ── AWS EC2 Instance Connect Recovery ──');
          console.log('   No SSH key found — using EC2 Instance Connect to establish access...');

          const keyDest = path.join(os.homedir(), '.ssh', stage + '_deploy_key');
          const pubKeyDest = keyDest + '.pub';

          // Generate new key pair locally
          if (!fs.existsSync(keyDest)) {
            try {
              execSync(
                'ssh-keygen -t ed25519 -f "' + keyDest + '" -N "" -C "' + stage + '-deploy"',
                { stdio: 'pipe' }
              );
              try { fs.chmodSync(keyDest, 0o600); } catch { /* Windows */ }
              console.log('   [OK] Generated SSH key: ' + keyDest);
            } catch (e) {
              console.log('   [!] ssh-keygen failed: ' + (e instanceof Error ? e.message : String(e)));
            }
          }

          if (fs.existsSync(keyDest) && fs.existsSync(pubKeyDest)) {
            const publicKey = fs.readFileSync(pubKeyDest, 'utf8').trim();

            // Push public key via Instance Connect (valid for 60 seconds)
            console.log('   Pushing temporary public key to EC2 instance ' + instanceId + '...');
            const pushed = await pushSshPublicKey(instanceId, user, publicKey, region);

            if (pushed) {
              console.log('   [OK] Public key pushed (valid for 60s)');

              // Try SSH against both domain and EC2 IP
              const ec2Ip = await findInstancePublicIp(projectName, region);
              const targets = [host];
              if (ec2Ip && ec2Ip !== host) targets.push(ec2Ip);

              let connectedHost: string | null = null;
              for (const target of targets) {
                const testResult = spawnSync('ssh', [
                  '-i', keyDest,
                  '-o', 'BatchMode=yes',
                  '-o', 'StrictHostKeyChecking=no',
                  '-o', 'ConnectTimeout=10',
                  user + '@' + target,
                  'echo ok',
                ], { encoding: 'utf8', stdio: 'pipe', timeout: 15000 });

                if (testResult.status === 0) {
                  connectedHost = target;
                  break;
                }
              }

              if (connectedHost) {
                console.log('   [OK] SSH connection verified via ' + connectedHost);

                // Permanently add public key to authorized_keys on the remote
                console.log('   Adding key permanently to remote authorized_keys...');
                const addKeyCmd = 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo "' + publicKey + '" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && sort -u -o ~/.ssh/authorized_keys ~/.ssh/authorized_keys';
                spawnSync('ssh', [
                  '-i', keyDest,
                  '-o', 'BatchMode=yes',
                  '-o', 'StrictHostKeyChecking=no',
                  '-o', 'ConnectTimeout=10',
                  user + '@' + connectedHost,
                  addKeyCmd,
                ], { encoding: 'utf8', stdio: 'pipe', timeout: 15000 });

                // Store in Ansible Vault
                if (config.ansible?.vault_path) {
                  try {
                    const store = new AnsibleVaultSecrets({
                      vault_path: config.ansible.vault_path,
                      vault_password_file: config.ansible.vault_password_file,
                      rootDir: rootDir ?? process.cwd(),
                    });
                    const privateKey = fs.readFileSync(keyDest, 'utf8');
                    const vaultResult = await store.setSecret(stage.toUpperCase() + '_SSH', privateKey);
                    if (vaultResult.success) {
                      console.log('   [OK] Stored ' + stage.toUpperCase() + '_SSH in Ansible Vault');
                    }
                  } catch { /* vault store best-effort */ }
                }

                // Write repo-specific key too
                try {
                  const { writeSshKeyToDisk } = await import('../plugins/pipelines/factiii/scanfix/secrets.js');
                  const privateKey = fs.readFileSync(keyDest, 'utf8');
                  writeSshKeyToDisk(stage, privateKey, config);
                } catch { /* best effort */ }

                console.log('   [OK] EC2 Instance Connect recovery complete');
                console.log('');
                resolvedKeyPath = keyDest;
              } else {
                console.log('   [!] SSH test failed after pushing key — Instance Connect agent may not be installed');
              }
            } else {
              console.log('   [!] EC2 Instance Connect push failed — agent may not be installed or IAM permissions missing');
            }
          }
        }
      }
    } catch { /* AWS not configured or import failed, skip */ }
  }

  // Shared variables for remote command building (used in Step 2 and Step 3)
  const projectDir = '$HOME/.factiii/' + repoName;
  const githubRepo = config.github_repo || '';

  // Auto-bootstrap: install dependencies and clone repo if missing on server
  const bootstrapCmd =
    // Install git if missing
    'if ! command -v git &>/dev/null; then ' +
      'echo "   Installing git..." && ' +
      'sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git; ' +
    'fi && ' +
    // Install Node.js if missing
    'if ! command -v node &>/dev/null; then ' +
      'echo "   Installing Node.js 20.x..." && ' +
      'curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && ' +
      'sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs; ' +
    'fi && ' +
    // Install Docker if missing
    'if ! command -v docker &>/dev/null; then ' +
      'echo "   Installing Docker..." && ' +
      'sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 && ' +
      'sudo usermod -aG docker $USER && ' +
      'sudo systemctl enable docker && sudo systemctl start docker; ' +
    'fi && ' +
    // Clone repo if missing (check .git dir to catch empty/broken clones)
    'if [ ! -d "' + projectDir + '/.git" ]; then ' +
      'echo "   Cloning project..." && ' +
      'mkdir -p $HOME/.factiii && ' +
      (githubRepo
        ? 'cd $HOME/.factiii && git clone https://github.com/' + githubRepo + '.git ' + repoName + '; '
        : 'echo "   [!] No github_repo configured — cannot auto-clone" && exit 1; ') +
    'fi && ';

  const projectCheckCmd = bootstrapCmd;

  // Step 2: Still no key — prompt for it (EC2: .pem file, others: password)
  if (!resolvedKeyPath) {
    const isEc2 = user === 'ubuntu' || user === 'ec2-user' || stage === 'prod';
    if (isEc2) {
      // EC2 uses key pair auth only — ask for .pem file once, then save to vault
      console.log('');
      console.log('   ── AWS EC2 SSH Key Required ──');
      console.log('   EC2 servers use key pair authentication, not passwords.');
      console.log('   Provide the .pem file downloaded when the EC2 instance was created.');
      console.log('');
      const pemPath = await promptSingleLine('   Path to your .pem file (e.g. ~/Downloads/factiii.pem): ');
      if (pemPath) {
        const expandedPemPath = pemPath.startsWith('~/')
          ? path.join(os.homedir(), pemPath.slice(2))
          : pemPath;
        if (fs.existsSync(expandedPemPath)) {
          const pemContent = fs.readFileSync(expandedPemPath, 'utf8');
          if (pemContent.includes('PRIVATE KEY')) {
            const keyDest = path.join(os.homedir(), '.ssh', stage + '_deploy_key');
            writeSecureKeyFile(keyDest, pemContent);
            console.log('   [OK] Key copied to ' + keyDest);
            if (config.ansible?.vault_path) {
              try {
                const store = new AnsibleVaultSecrets({
                  vault_path: config.ansible.vault_path,
                  vault_password_file: config.ansible.vault_password_file,
                  rootDir: rootDir ?? process.cwd(),
                });
                await store.setSecret(stage.toUpperCase() + '_SSH', pemContent);
                console.log('   [OK] Saved to Ansible Vault as ' + stage.toUpperCase() + "_SSH (won't ask again)");
              } catch { /* vault save is best-effort */ }
            }
            resolvedKeyPath = keyDest;
          } else {
            console.log('   [!] File does not contain a valid private key');
          }
        } else {
          console.log('   [!] File not found: ' + expandedPemPath);
        }
      }
    }

    if (!resolvedKeyPath) {
      // Last resort: password for non-EC2 servers
      const pwRemoteCommand = 'export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH" && export FACTIII_ON_SERVER=true && ' +
        projectCheckCmd +
        'cd ' + projectDir + ' && npx -y @factiii/stack@latest ' + command;
      let password = getSshPasswordFromVault(stage, config, rootDir);
      if (!password) {
        password = await promptAndValidatePassword(stage, host, user, config, rootDir);
      }
      if (!password) {
        return {
          success: false,
          stdout: '',
          stderr: 'No SSH key for ' + stage + '. For EC2: provide the .pem file from AWS Console.',
        };
      }
      console.log('   SSH (password): ' + user + '@' + host + ' → npx stack ' + command);
      const pwStart = Date.now();
      const pwResult = spawnSync('sshpass', [
        '-p', password, 'ssh', '-tt',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=60',
        '-o', 'ServerAliveCountMax=5',
        user + '@' + host,
        pwRemoteCommand,
      ], { encoding: 'utf8', stdio: 'inherit', timeout: 600000 });
      console.log('   SSH completed in ' + Math.floor((Date.now() - pwStart) / 1000) + 's');
      return {
        success: pwResult.status === 0,
        stdout: '',
        stderr: pwResult.status !== 0 ? 'SSH command exited with code ' + pwResult.status : '',
      };
    }
  }

  // Step 3: We have a key — build command and run
  const activeKeyPath = resolvedKeyPath as string;

  const remoteCommand = 'export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH" && export FACTIII_ON_SERVER=true && ' +
    projectCheckCmd +
    'cd ' + projectDir + ' && npx -y @factiii/stack@latest ' + command;

  // Quick-test the key before using it for a long operation
  console.log('   Testing SSH key: ' + activeKeyPath);

  const keyTest = spawnSync('ssh', [
    '-i', activeKeyPath,
    '-o', 'BatchMode=yes',             // No interactive password prompt
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=5',
    user + '@' + host,
    'echo ok',
  ], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 10000,
  });

  if (keyTest.status !== 0) {
    // Categorize key type — only remove repo-specific deploy keys, not system/.pem keys
    const isRepoSpecificKey = activeKeyPath.includes('_deploy_key') || activeKeyPath.endsWith('_factiii');
    const isPemKey = activeKeyPath.endsWith('.pem');
    const isSystemKey = activeKeyPath.endsWith('id_rsa') || activeKeyPath.endsWith('id_ed25519') || activeKeyPath.endsWith('id_ecdsa');
    const canDeleteKey = isRepoSpecificKey && !isPemKey && !isSystemKey;

    console.log('   [!] SSH key auth failed against ' + host + (canDeleteKey ? '' : ' (key not authorized on server): ' + path.basename(activeKeyPath)));

    // For prod AWS EC2: try EC2 public IP BEFORE deleting the key
    // Domain DNS may not have propagated yet, but the key itself may be valid
    if (stage === 'prod' && config.aws) {
      try {
        const { findInstancePublicIp } = await import('../plugins/pipelines/aws/utils/aws-helpers.js');
        const { getAwsConfig } = await import('../plugins/pipelines/aws/utils/aws-helpers.js');
        const { region } = getAwsConfig(config);
        const projectName = config.name ?? path.basename(rootDir ?? process.cwd());
        const ec2Ip = await findInstancePublicIp(projectName, region);

        if (ec2Ip && ec2Ip !== host) {
          console.log('   [!] Domain ' + host + ' may not have resolved to EC2 yet (DNS propagation)');
          console.log('   Retrying with EC2 IP: ' + ec2Ip);
          const ipTest = spawnSync('ssh', [
            '-i', activeKeyPath,
            '-o', 'BatchMode=yes',
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'ConnectTimeout=10',
            user + '@' + ec2Ip,
            'echo ok',
          ], { encoding: 'utf8', stdio: 'pipe', timeout: 15000 });

          if (ipTest.status === 0) {
            console.log('   [OK] Connected via EC2 IP. DNS will resolve once propagated (~48h).');
            const startTime = Date.now();
            const result = spawnSync('ssh', [
              '-tt', '-i', activeKeyPath,
              '-o', 'StrictHostKeyChecking=no',
              '-o', 'ConnectTimeout=10',
              '-o', 'ServerAliveInterval=60',
              '-o', 'ServerAliveCountMax=5',
              user + '@' + ec2Ip, remoteCommand,
            ], { encoding: 'utf8', stdio: 'inherit', timeout: 600000 });
            console.log('   SSH completed in ' + Math.floor((Date.now() - startTime) / 1000) + 's');
            return {
              success: result.status === 0,
              stdout: '',
              stderr: result.status !== 0 ? 'SSH command exited with code ' + result.status : '',
            };
          } else {
            console.log('   [!] EC2 IP also failed — key may not be authorized yet (EC2 may still be starting)');
          }
        }
      } catch { /* AWS not configured, skip */ }
    }

    // Key failed against both domain and EC2 IP — now safe to delete
    if (canDeleteKey) {
      console.log('   [!] Removing bad deploy key: ' + activeKeyPath);
      try { fs.unlinkSync(activeKeyPath); } catch { /* ok */ }
      try { fs.unlinkSync(activeKeyPath + '.pub'); } catch { /* ok */ }
    }

    // Search for other working keys — test each without deleting on failure
    const altKeyPath = findSshKeyForStage(stage, repoName);
    if (altKeyPath && altKeyPath !== activeKeyPath) {
      console.log('   Found alternate key: ' + altKeyPath);
      const altTest = spawnSync('ssh', [
        '-i', altKeyPath,
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=5',
        user + '@' + host,
        'echo ok',
      ], { encoding: 'utf8', stdio: 'pipe', timeout: 10000 });

      if (altTest.status === 0) {
        // This key works — use it
        console.log('   [OK] Alternate key works');
        const startTime = Date.now();
        const result = spawnSync('ssh', [
          '-tt', '-i', altKeyPath,
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'ConnectTimeout=10',
          '-o', 'ServerAliveInterval=60',
          '-o', 'ServerAliveCountMax=5',
          user + '@' + host, remoteCommand,
        ], { encoding: 'utf8', stdio: 'inherit', timeout: 600000 });
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        console.log('   SSH completed in ' + elapsed + 's');
        return {
          success: result.status === 0,
          stdout: '',
          stderr: result.status !== 0 ? 'SSH command exited with code ' + result.status : '',
        };
      } else {
        console.log('   [!] Alternate key also failed (not authorized on server)');
      }
    }

    // No working key found — fall back to password / auto key setup
    let password = getSshPasswordFromVault(stage, config, rootDir);
    if (!password) {
      password = await promptAndValidatePassword(stage, host, user, config, rootDir);
    }

    if (password) {
      console.log('   Falling back to SSH password auth...');
      console.log('   SSH (password): ' + user + '@' + host + ' → npx stack ' + command);
      const startTime = Date.now();
      const result = spawnSync('sshpass', [
        '-p', password,
        'ssh',
        '-tt',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=60',
        '-o', 'ServerAliveCountMax=5',
        user + '@' + host,
        remoteCommand,
      ], {
        encoding: 'utf8',
        stdio: 'inherit',
        timeout: 600000,
      });
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log('   SSH completed in ' + elapsed + 's');

      if (result.status === 0) {
        return { success: true, stdout: '', stderr: '' };
      }

      // sshpass failed (null exit code = keyboard-interactive server)
      // Try auto key generation as last resort
      console.log('   [!] sshpass failed (server may use keyboard-interactive auth)');
      console.log('   Setting up SSH key auth for future connections...');

      const autoKeyResult = await autoSetupSshKey(stage, host, user, config, rootDir);
      if (autoKeyResult) {
        // Retry the command with the new key
        console.log('   Retrying command with SSH key...');
        console.log('   SSH (key): ' + user + '@' + host + ' → npx stack ' + command);
        const retryStart = Date.now();
        const retryResult = spawnSync('ssh', [
          '-tt',
          '-i', autoKeyResult,
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'ConnectTimeout=10',
          '-o', 'ServerAliveInterval=60',
          '-o', 'ServerAliveCountMax=5',
          user + '@' + host,
          remoteCommand,
        ], {
          encoding: 'utf8',
          stdio: 'inherit',
          timeout: 600000,
        });
        const retryElapsed = Math.floor((Date.now() - retryStart) / 1000);
        console.log('   SSH completed in ' + retryElapsed + 's');
        return {
          success: retryResult.status === 0,
          stdout: '',
          stderr: retryResult.status !== 0 ? 'SSH command exited with code ' + retryResult.status : '',
        };
      }

      return {
        success: false,
        stdout: '',
        stderr: 'SSH command exited with code ' + result.status,
      };
    }

    // No password available either — try auto key generation directly
    console.log('   [!] No SSH key or password available.');
    console.log('   Attempting auto SSH key setup...');
    const autoKeyResult = await autoSetupSshKey(stage, host, user, config, rootDir);
    if (autoKeyResult) {
      console.log('   SSH (key): ' + user + '@' + host + ' → npx stack ' + command);
      const retryStart = Date.now();
      const retryResult = spawnSync('ssh', [
        '-tt',
        '-i', autoKeyResult,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=60',
        '-o', 'ServerAliveCountMax=5',
        user + '@' + host,
        remoteCommand,
      ], {
        encoding: 'utf8',
        stdio: 'inherit',
        timeout: 600000,
      });
      const retryElapsed = Math.floor((Date.now() - retryStart) / 1000);
      console.log('   SSH completed in ' + retryElapsed + 's');
      return {
        success: retryResult.status === 0,
        stdout: '',
        stderr: retryResult.status !== 0 ? 'SSH command exited with code ' + retryResult.status : '',
      };
    }

    return {
      success: false,
      stdout: '',
      stderr: 'SSH key auth failed and no password available',
    };
  }

  console.log('   [OK] SSH key valid');

  // Sync config files to server (stack.yml, .env.prod, etc.)
  // Dev machine is the source of truth — server may not have these in git
  const configRoot = rootDir ?? process.cwd();
  const remoteProjectDir = '~/.factiii/' + repoName;
  const filesToSync = ['stack.yml', 'stackAuto.yml', '.env.prod', '.env.staging'];
  const existingFiles = filesToSync.filter(f => fs.existsSync(path.join(configRoot, f)));
  if (existingFiles.length > 0) {
    // Ensure remote project dir exists
    spawnSync('ssh', [
      '-i', activeKeyPath,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=5',
      user + '@' + host,
      'mkdir -p ' + remoteProjectDir,
    ], { encoding: 'utf8', stdio: 'pipe', timeout: 10000 });

    for (const file of existingFiles) {
      const localPath = path.join(configRoot, file);
      const remotePath = user + '@' + host + ':' + remoteProjectDir + '/' + file;
      const scpResult = spawnSync('scp', [
        '-i', activeKeyPath,
        '-o', 'StrictHostKeyChecking=no',
        localPath, remotePath,
      ], { encoding: 'utf8', stdio: 'pipe', timeout: 15000 });
      if (scpResult.status === 0) {
        console.log('   [OK] Synced ' + file + ' to server');
      }
    }
  }

  console.log('   SSH: ' + user + '@' + host + ' → npx stack ' + command);
  console.log('   Connecting to ' + host + '... (timeout: 10min)');

  const startTime = Date.now();

  const result = spawnSync('ssh', [
    '-tt',  // Force TTY allocation so sudo prompts work over SSH
    '-i', activeKeyPath,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=60',
    '-o', 'ServerAliveCountMax=5',
    user + '@' + host,
    remoteCommand,
  ], {
    encoding: 'utf8',
    stdio: 'inherit',  // Pass through stdin/stdout/stderr for interactive sudo
    timeout: 600000, // 10 minute timeout for long-running operations
  });

  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  console.log('   SSH completed in ' + elapsed + 's');

  // With stdio: 'inherit', output is streamed directly to terminal.
  // stdout/stderr are null in the result, so we return empty strings.
  return {
    success: result.status === 0,
    stdout: '',
    stderr: result.status !== 0 ? 'SSH command exited with code ' + result.status : '',
  };
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
  const sshRepoName = config?.name;
  if (stage) {
    keyPath = findSshKeyForStage(stage, sshRepoName);
  }

  // Fallback: try all known deploy keys (repo-specific first, then generic)
  if (!keyPath) {
    const fallbackStages = ['staging', 'prod', 'mac'];
    const keyPaths: string[] = [];
    for (const s of fallbackStages) {
      for (const k of getKeyNamesForStage(s, sshRepoName)) {
        keyPaths.push(path.join(os.homedir(), '.ssh', k));
      }
    }
    // Deduplicate
    const seen = new Set<string>();

    for (const kp of keyPaths) {
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
      password = getSshPasswordFromVault(stage, config, rootDir);

      // No stored password — prompt user, validate, and store
      if (!password) {
        password = await promptAndValidatePassword(stage, host as string, user, config, rootDir);
      }
    }

    if (password) {
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
    throw new Error(result.stderr || 'SSH command failed with exit code ' + result.status);
  }

  return (result.stdout ?? '').trim();
}
