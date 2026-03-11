/**
 * GitHub CLI fixes for Factiii Pipeline plugin
 * Handles GitHub CLI installation for dev environment
 */

import * as fs from 'fs';
import { execSync } from 'child_process';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { hasEnvironments } from '../../../../utils/config-helpers.js';

/**
 * Check if gh CLI is available on the system.
 * On Windows, also checks common install paths since PATH may not be refreshed.
 */
function isGhInstalled(): boolean {
  const cmd = process.platform === 'win32' ? 'where gh' : 'which gh';
  try {
    execSync(cmd, { stdio: 'pipe' });
    return true;
  } catch {
    // On Windows, check default install path (PATH may not be refreshed)
    if (process.platform === 'win32') {
      return fs.existsSync('C:\\Program Files\\GitHub CLI\\gh.exe')
        || fs.existsSync('C:\\Program Files (x86)\\GitHub CLI\\gh.exe');
    }
    return false;
  }
}

export const githubCliFixes: Fix[] = [
  {
    id: 'gh-cli-not-installed',
    stage: 'dev',
    severity: 'info',
    description: '🔧 GitHub CLI not installed (recommended for deployment monitoring)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (!hasEnvironments(_config)) return false;
      // Only needed on dev machine, not on staging/prod servers
      if (process.env.FACTIII_ON_SERVER) return false;
      return !isGhInstalled();
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (process.platform === 'win32') {
        console.log('   Installing GitHub CLI via winget...');
        try {
          execSync('winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements', { stdio: 'inherit' });
        } catch {
          // winget returns non-zero for "already installed, no upgrade"
        }
      } else {
        console.log('   Installing GitHub CLI via Homebrew...');
        try {
          execSync('which brew', { stdio: 'pipe' });
          execSync('brew install gh', { stdio: 'inherit' });
        } catch {
          // brew may fail if already installed
        }
      }

      if (isGhInstalled()) {
        console.log('   ✅ GitHub CLI is installed. Restart terminal if `gh` is not in PATH, then run: gh auth login');
        return true;
      }

      console.log(process.platform === 'win32'
        ? '   ⚠️  Installation failed. Install manually: winget install GitHub.cli'
        : '   ⚠️  Installation failed. Install manually: brew install gh');
      return false;
    },
    manualFix: process.platform === 'win32'
      ? 'Install GitHub CLI: winget install GitHub.cli (or visit https://cli.github.com/)'
      : 'Install GitHub CLI: brew install gh (or visit https://cli.github.com/)',
  },
];
