/**
 * Shared Node.js Fixes
 *
 * Platform-aware Node.js installation checks.
 * Used by mac, ubuntu, and aws plugins.
 */

import { execSync } from 'child_process';
import type { Fix, Stage, FactiiiConfig } from '../../types/index.js';
import { detectPlatform } from '../platform.js';
import { nodeCommands } from '../commands/index.js';

/**
 * Create Node.js installation check fix
 *
 * @param stage The stage to check (dev, staging, prod)
 */
export function createNodeInstallFix(stage: Stage): Fix {
  const platform = detectPlatform();
  const commands = nodeCommands[platform];
  const id = stage + '-node-missing';
  const stageLabel = stage === 'dev' ? 'locally' : 'on ' + stage + ' server';

  return {
    id,
    stage,
    severity: 'critical',
    description: 'Node.js not installed ' + stageLabel,
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // For non-dev stages, check if environment is configured
      if (stage !== 'dev') {
        const envConfig = stage === 'prod'
          ? (config?.environments?.prod ?? config?.environments?.production)
          : config?.environments?.[stage];
        if (!envConfig?.domain) return false;
      }

      try {
        execSync(commands.check, { stdio: 'pipe' });
        return false; // Node.js is installed
      } catch {
        return true; // Node.js is not installed
      }
    },
    fix: commands.install
      ? async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
          console.log('   Installing Node.js...');
          try {
            execSync(commands.install!, { stdio: 'inherit' });
            return true;
          } catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            console.log('   Failed: ' + errorMessage);
            return false;
          }
        }
      : null,
    manualFix: commands.manualFix,
  };
}

/**
 * Get all Node.js fixes for a stage
 *
 * @param stage The stage (dev, staging, prod)
 */
export function getNodeFixes(stage: Stage): Fix[] {
  return [createNodeInstallFix(stage)];
}
