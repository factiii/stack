/**
 * GitHub CLI fixes for Factiii Pipeline plugin
 * Handles GitHub CLI installation for dev environment
 */

import { execSync } from 'child_process';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';

export const githubCliFixes: Fix[] = [
  {
    id: 'gh-cli-not-installed',
    stage: 'dev',
    severity: 'info',
    description: 'GitHub CLI not installed (recommended for deployment monitoring)',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        execSync('which gh', { stdio: 'pipe' });
        return false;
      } catch {
        return true;
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      console.log('   Installing GitHub CLI via Homebrew...');
      try {
        // Check if brew is available
        execSync('which brew', { stdio: 'pipe' });

        // Install gh CLI
        execSync('brew install gh', { stdio: 'inherit' });

        console.log('   ✅ GitHub CLI installed successfully!');
        console.log('   💡 Run: gh auth login');
        return true;
      } catch {
        console.log('   ⚠️  Homebrew not found or installation failed');
        return false;
      }
    },
    manualFix: 'Install GitHub CLI: brew install gh (or visit https://cli.github.com/)',
  },
];

