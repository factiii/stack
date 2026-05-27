/**
 * Migration: move legacy ~/.ssh/<stage>_deploy_key{,_<project>} into
 * ~/.ssh/factiii/<project>/<stage>_deploy_key.
 *
 * - Suffixed copies (staging_deploy_key_<project>) are MOVED — they unambiguously
 *   belong to this project.
 * - Unsuffixed copies (staging_deploy_key) are COPIED, not moved — another repo
 *   on this machine may still depend on the legacy path until it runs its own
 *   migration.
 * - .pem files are not auto-migrated. User configures aws.prod_ssh_key_path
 *   directly if needed.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { FactiiiConfig, Fix } from '../../../../../types/index.js';
import { getStackProjectName } from '../../../../../utils/project-identifier.js';

const STAGES: Array<'staging' | 'prod'> = ['staging', 'prod'];

// CRITICAL: Use process.env.HOME before os.homedir() so that test environments
// can redirect home-relative paths via $HOME. On macOS, os.homedir() uses a
// syscall that ignores runtime $HOME changes, making process.env.HOME necessary
// for test isolation.
function getHome(): string {
  return process.env.HOME || os.homedir();
}

function sshDir(): string {
  return path.join(getHome(), '.ssh');
}

function targetSshDir(projectName: string): string {
  return path.join(getHome(), '.ssh', 'factiii', projectName);
}

function targetSshKeyPath(projectName: string, stage: string): string {
  return path.join(targetSshDir(projectName), stage + '_deploy_key');
}

function legacyPaths(projectName: string): Array<{ stage: string; suffixed: string; unsuffixed: string }> {
  const dir = sshDir();
  return STAGES.map(stage => ({
    stage,
    suffixed: path.join(dir, stage + '_deploy_key_' + projectName),
    unsuffixed: path.join(dir, stage + '_deploy_key'),
  }));
}

export const sshKeysLocationFix: Fix = {
  id: 'ssh-keys-location',
  stage: 'dev',
  severity: 'critical',
  blocking: true,
  description: 'Move SSH deploy keys into ~/.ssh/factiii/<project>/',
  scan: async function (config: FactiiiConfig, _rootDir: string): Promise<boolean> {
    let projectName: string;
    try { projectName = getStackProjectName(config); } catch { return false; }
    const dir = targetSshDir(projectName);
    if (fs.existsSync(dir)) return false; // Already migrated
    return legacyPaths(projectName).some(p => fs.existsSync(p.suffixed) || fs.existsSync(p.unsuffixed));
  },
  fix: async function (config: FactiiiConfig, _rootDir: string): Promise<boolean> {
    let projectName: string;
    try { projectName = getStackProjectName(config); } catch { return false; }
    const dir = targetSshDir(projectName);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    for (const { stage, suffixed, unsuffixed } of legacyPaths(projectName)) {
      const target = targetSshKeyPath(projectName, stage);
      if (fs.existsSync(suffixed)) {
        fs.renameSync(suffixed, target);
        if (fs.existsSync(suffixed + '.pub')) fs.renameSync(suffixed + '.pub', target + '.pub');
        fs.chmodSync(target, 0o600);
        console.log('   [OK] Moved ' + suffixed + ' -> ' + target);
      } else if (fs.existsSync(unsuffixed)) {
        fs.copyFileSync(unsuffixed, target);
        if (fs.existsSync(unsuffixed + '.pub')) fs.copyFileSync(unsuffixed + '.pub', target + '.pub');
        fs.chmodSync(target, 0o600);
        console.log('   [OK] Copied ' + unsuffixed + ' -> ' + target);
        console.log('        Original kept in place - delete it once all stack repos have migrated.');
      }
    }
    return true;
  },
  manualFix:
    'Create ~/.ssh/factiii/<project>/ (mode 0700) and copy staging_deploy_key + prod_deploy_key into it (mode 0600).',
};
