/**
 * Dev Reset Command
 *
 * Deletes local config and secrets files so developers can re-test
 * the 0-to-deployed flow (bootstrap → fix → deploy) from scratch.
 *
 * Only touches LOCAL files — no AWS cleanup, no server cleanup.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { loadConfig } from '../utils/config-helpers.js';

interface DevResetOptions {
  dryRun?: boolean;
}

/**
 * Collect all local files that would be deleted.
 * Returns array of { path, label } for display.
 */
function collectFiles(rootDir: string, projectName: string): Array<{ path: string; label: string }> {
  const files: Array<{ path: string; label: string }> = [];
  const home = os.homedir();

  // Project root config files
  const rootFiles = ['stack.yml', 'stackAuto.yml', 'stack.local.yml', '.env.staging', '.env.prod'];
  for (const f of rootFiles) {
    const fullPath = path.join(rootDir, f);
    if (fs.existsSync(fullPath)) {
      files.push({ path: fullPath, label: f });
    }
  }

  // Vault directory (group_vars/)
  const groupVarsDir = path.join(rootDir, 'group_vars');
  if (fs.existsSync(groupVarsDir)) {
    files.push({ path: groupVarsDir, label: 'group_vars/' });
  }

  // GitHub workflow files (stack-*.yml only)
  const workflowDir = path.join(rootDir, '.github', 'workflows');
  if (fs.existsSync(workflowDir)) {
    try {
      const workflowFiles = fs.readdirSync(workflowDir).filter(f => f.startsWith('stack-') && f.endsWith('.yml'));
      for (const f of workflowFiles) {
        files.push({ path: path.join(workflowDir, f), label: '.github/workflows/' + f });
      }
    } catch {
      // Permission error — skip
    }
  }

  // Vault password file
  const vaultPass = path.join(home, '.vault_pass');
  if (fs.existsSync(vaultPass)) {
    files.push({ path: vaultPass, label: '~/.vault_pass' });
  }

  // SSH deploy keys (generic + repo-specific)
  const sshDir = path.join(home, '.ssh');
  if (fs.existsSync(sshDir)) {
    try {
      const sshFiles = fs.readdirSync(sshDir);
      for (const stage of ['staging', 'prod']) {
        for (const f of sshFiles) {
          if (f.startsWith(stage + '_deploy_key')) {
            // Match generic keys and repo-specific keys
            // e.g. staging_deploy_key, staging_deploy_key_myapp, staging_deploy_key.pub
            files.push({ path: path.join(sshDir, f), label: '~/.ssh/' + f });
          }
        }
      }
    } catch {
      // Permission error — skip
    }
  }

  return files;
}

/**
 * Prompt user to type the project name for confirmation.
 */
async function confirmReset(projectName: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question('Type "' + projectName + '" to confirm: ', (answer: string) => {
      rl.close();
      resolve(answer.trim() === projectName);
    });
  });
}

export async function devReset(options: DevResetOptions = {}): Promise<void> {
  const rootDir = process.cwd();

  // Try to load config for project name (before we delete it)
  let projectName = 'unknown';
  try {
    const config = loadConfig(rootDir);
    if (config?.name) {
      projectName = config.name as string;
    }
  } catch {
    // No config — use directory name
    projectName = path.basename(rootDir);
  }

  const files = collectFiles(rootDir, projectName);

  if (files.length === 0) {
    console.log('Nothing to reset — no local config or secrets files found.');
    return;
  }

  // Show what will be deleted
  console.log('');
  console.log('WARNING: This will DELETE local config and secrets:');
  console.log('');
  for (const f of files) {
    console.log('  ' + (options.dryRun ? '[dry-run] ' : '') + f.label);
  }
  console.log('');

  if (options.dryRun) {
    console.log(files.length + ' file(s) would be deleted.');
    console.log('Run without --dry-run to execute.');
    return;
  }

  // Confirmation
  const confirmed = await confirmReset(projectName);
  if (!confirmed) {
    console.log('Cancelled.');
    return;
  }

  // Delete files
  let deleted = 0;
  for (const f of files) {
    try {
      const stat = fs.statSync(f.path);
      if (stat.isDirectory()) {
        fs.rmSync(f.path, { recursive: true, force: true });
      } else {
        fs.unlinkSync(f.path);
      }
      deleted++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log('  Failed to delete ' + f.label + ': ' + msg);
    }
  }

  console.log('');
  console.log('Dev reset complete — ' + deleted + ' item(s) deleted');
  console.log('Run `npx stack` to start fresh bootstrap');
}

export default devReset;
