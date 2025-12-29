/**
 * Git-related fixes for Mac Mini plugin
 * Handles Git installation on staging server
 */

import { execSync } from 'child_process';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';

export const gitFixes: Fix[] = [
  {
    id: 'staging-git-missing',
    stage: 'staging',
    severity: 'critical',
    description: 'Git not installed on staging server',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const hasStagingEnv = config?.environments?.staging;
      if (!hasStagingEnv) return false;

      const host = config?.environments?.staging?.host;
      if (!host) return false;

      // Executed locally - SSH handled by CLI wrapper
      try {
        execSync('which git', { stdio: 'pipe' });
        return false; // git is installed
      } catch {
        return true; // git is not installed
      }
    },
    fix: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // Executed locally - SSH handled by CLI wrapper
      console.log('   Installing git on staging server...');
      try {
        execSync('brew install git || sudo apt-get install -y git', { stdio: 'inherit' });
        return true;
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.log(`   Failed: ${errorMessage}`);
        return false;
      }
    },
    manualFix:
      'SSH to server and install git: brew install git (Mac) or sudo apt-get install git (Linux)',
  },
];

