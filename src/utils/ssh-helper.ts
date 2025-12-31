/**
 * SSH Helper Utility
 *
 * Shared SSH execution logic for pipeline and server plugins.
 * Provides a consistent way to execute commands on remote servers.
 */
import { execSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import type { EnvironmentConfig } from '../types/index.js';

/**
 * Execute a command on a remote server via SSH
 * @param envConfig - Environment config with host and ssh_user
 * @param command - Command to execute
 * @returns Command output
 */
export async function sshExec(
  envConfig: EnvironmentConfig,
  command: string
): Promise<string> {
  // ============================================================
  // CRITICAL: Detect if we're already on the server
  // ============================================================
  // When GITHUB_ACTIONS=true, we're executing on the server itself
  // (workflow SSHs to server and runs the command there)
  // In this case, run commands locally instead of trying to SSH
  // ============================================================
  if (process.env.GITHUB_ACTIONS === 'true') {
    // We're already on the server - run command locally
    const result = execSync(command, { encoding: 'utf8', stdio: 'pipe' });
    return result.trim();
  }

  // Running from dev machine - SSH to server
  const host = envConfig.domain;
  const user = envConfig.ssh_user ?? 'ubuntu';

  // Try to find SSH key
  const keyPaths = [
    path.join(os.homedir(), '.ssh', 'id_ed25519'),
    path.join(os.homedir(), '.ssh', 'id_rsa'),
  ];

  let keyPath: string | null = null;
  for (const kp of keyPaths) {
    if (fs.existsSync(kp)) {
      keyPath = kp;
      break;
    }
  }

  if (!keyPath) {
    throw new Error('No SSH key found');
  }

  const result = execSync(
    `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${user}@${host} "${command.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', stdio: 'pipe' }
  );

  return result.trim();
}

