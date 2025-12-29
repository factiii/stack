/**
 * Node.js fixes for AWS plugin
 * Handles Node.js installation on production server
 */

import { execSync } from 'child_process';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';

export const nodeFixes: Fix[] = [
  {
    id: 'prod-node-missing',
    stage: 'prod',
    severity: 'critical',
    description: 'Node.js not installed on production server',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const envConfig =
        config?.environments?.prod ?? config?.environments?.production;
      if (!envConfig) return false;
      if (!envConfig?.host) return false;

      // Executed locally - SSH handled by CLI wrapper
      try {
        execSync('which node', { stdio: 'pipe' });
        return false;
      } catch {
        return true;
      }
    },
    fix: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // Executed locally - SSH handled by CLI wrapper
      console.log('   Installing Node.js on production server...');
      const envConfig =
        config?.environments?.prod ?? config?.environments?.production;
      if (!envConfig) return false;
      
      try {
        execSync(
          'curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs',
          { stdio: 'inherit' }
        );
        return true;
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.log(`   Failed: ${errorMessage}`);
        return false;
      }
    },
    manualFix: 'SSH to server and install Node.js via NodeSource',
  },
];

