/**
 * Node.js and pnpm fixes for Mac Mini plugin
 * Handles Node.js and pnpm installation on staging server
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import yaml from 'js-yaml';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';

interface AutoConfig {
  package_manager?: string;
}

export const nodeFixes: Fix[] = [
  {
    id: 'staging-node-missing',
    stage: 'staging',
    severity: 'critical',
    description: 'Node.js not installed on staging server',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const hasStagingEnv = config?.environments?.staging;
      if (!hasStagingEnv) return false;

      const domain = config?.environments?.staging?.domain;
      if (!domain) return false;

      // Executed locally - SSH handled by CLI wrapper
      try {
        execSync('which node', { stdio: 'pipe' });
        return false; // Node.js is installed
      } catch {
        return true; // Node.js is not installed
      }
    },
    fix: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // Executed locally - SSH handled by CLI wrapper
      console.log('   Installing Node.js on staging server...');
      try {
        execSync('brew install node || (curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs)', { stdio: 'inherit' });
        return true;
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.log(`   Failed: ${errorMessage}`);
        return false;
      }
    },
    manualFix:
      'SSH to server and install Node.js: brew install node (Mac) or use NodeSource (Linux)',
  },
  {
    id: 'staging-pnpm-missing',
    stage: 'staging',
    severity: 'warning',
    description: 'pnpm not installed on staging server',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      // Only check if staging environment is defined in config
      const hasStagingEnv = config?.environments?.staging;
      if (!hasStagingEnv) return false;

      // Only check if project uses pnpm
      const autoConfigPath = path.join(rootDir, 'factiiiAuto.yml');
      if (!fs.existsSync(autoConfigPath)) return false;

      try {
        const autoConfig = yaml.load(
          fs.readFileSync(autoConfigPath, 'utf8')
        ) as AutoConfig | null;
        if (autoConfig?.package_manager !== 'pnpm') return false;
      } catch {
        return false;
      }

      const domain = config?.environments?.staging?.domain;
      if (!domain) return false;

      // Executed locally - SSH handled by CLI wrapper
      try {
        execSync('which pnpm', { stdio: 'pipe' });
        return false; // pnpm is installed
      } catch {
        return true; // pnpm is not installed
      }
    },
    fix: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // Executed locally - SSH handled by CLI wrapper
      console.log('   Installing pnpm on staging server...');
      try {
        execSync('npm install -g pnpm@9', { stdio: 'inherit' });
        return true;
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.log(`   Failed: ${errorMessage}`);
        return false;
      }
    },
    manualFix: 'SSH to server and run: npm install -g pnpm@9',
  },
];

