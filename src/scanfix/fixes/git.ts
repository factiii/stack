/**
 * Shared Git Fixes
 *
 * Platform-aware Git installation checks.
 * Used by mac, ubuntu, and aws plugins.
 */

import { execSync } from 'child_process';
import type { Fix, Stage, FactiiiConfig } from '../../types/index.js';
import { detectPlatform } from '../platform.js';
import { gitCommands } from '../commands/index.js';

/**
 * Create Git installation check fix
 *
 * @param stage The stage to check (dev, staging, prod)
 */
export function createGitInstallFix(stage: Stage): Fix {
  const platform = detectPlatform();
  const commands = gitCommands[platform];
  const id = stage + '-git-missing';
  const stageLabel = stage === 'dev' ? 'locally' : 'on ' + stage + ' server';

  return {
    id,
    stage,
    severity: 'critical',
    description: 'Git not installed ' + stageLabel,
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
        return false; // Git is installed
      } catch {
        return true; // Git is not installed
      }
    },
    fix: commands.install
      ? async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
          console.log('   Installing Git...');
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
 * Get all Git fixes for a stage
 *
 * @param stage The stage (dev, staging, prod)
 */
export function getGitFixes(stage: Stage): Fix[] {
  return [createGitInstallFix(stage)];
}
