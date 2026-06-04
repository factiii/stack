/**
 * Migration: move ~/.vault_pass to <repo>/.vault_pass for per-repo isolation.
 *
 * Triggered when `ansible.vault_password_file` resolves to a path outside the repo
 * root (typically ~/.vault_pass). Copies the file into the repo, rewrites stack.yml,
 * and adds .vault_pass to .gitignore. Does not delete the home file — other
 * unmigrated repos on this machine may still need it.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { FactiiiConfig, Fix } from '../../../../../types/index.js';
import { ensureGitignored } from '../../../../../utils/gitignore.js';

function resolvePath(p: string, rootDir: string): string {
  const expanded = p.replace(/^~/, os.homedir());
  return path.isAbsolute(expanded) ? expanded : path.join(rootDir, expanded);
}

export const vaultPasswordFileLocationFix: Fix = {
  id: 'vault-password-file-location',
  stage: 'dev',
  severity: 'critical',
  blocking: true,
  description: 'Vault password file should live in the repo, not in $HOME',
  scan: async function (config: FactiiiConfig, rootDir: string): Promise<boolean> {
    const configured = config.ansible?.vault_password_file;
    if (!configured) return false; // No vault → nothing to migrate yet
    const localPath = path.join(rootDir, '.vault_pass');
    if (fs.existsSync(localPath)) return false; // Already migrated
    const resolved = resolvePath(configured, rootDir);
    // Trigger if the resolved path lives outside the repo (typically ~/.vault_pass)
    return !resolved.startsWith(rootDir + path.sep);
  },
  fix: async function (config: FactiiiConfig, rootDir: string): Promise<boolean> {
    const configured = config.ansible?.vault_password_file;
    if (!configured) return false;
    const src = resolvePath(configured, rootDir);
    if (!fs.existsSync(src)) {
      console.log('   [!] Source vault password file not found: ' + src);
      return false;
    }
    const dest = path.join(rootDir, '.vault_pass');
    fs.copyFileSync(src, dest);
    fs.writeFileSync(dest, fs.readFileSync(dest, 'utf8'), { mode: 0o600 });
    if (process.platform === 'win32') {
      try { require('child_process').execSync('icacls "' + dest + '" /inheritance:r /grant:r "%USERNAME%:F" 2>nul', { stdio: 'pipe', windowsHide: true }); } catch { /* best effort */ }
    }
    console.log('   [OK] Copied ' + src + ' → ' + dest);

    // Rewrite stack.yml in place — string replace is sufficient for this simple value
    const stackPath = path.join(rootDir, 'stack.yml');
    if (fs.existsSync(stackPath)) {
      let content = fs.readFileSync(stackPath, 'utf8');
      content = content.replace(
        /vault_password_file:\s*\S+/,
        'vault_password_file: .vault_pass'
      );
      fs.writeFileSync(stackPath, content, 'utf8');
      console.log('   [OK] Updated stack.yml ansible.vault_password_file to .vault_pass');
    }

    ensureGitignored(rootDir, '.vault_pass');
    console.log('   [--] Leaving ' + src + ' in place — delete it once all stack repos have migrated.');
    return true;
  },
  manualFix:
    'Copy ~/.vault_pass to <repo>/.vault_pass (mode 0600), set ansible.vault_password_file: .vault_pass in stack.yml, add .vault_pass to .gitignore.',
};
