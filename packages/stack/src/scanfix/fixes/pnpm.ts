/**
 * Shared pnpm Fixes
 *
 * Platform-aware pnpm installation checks.
 * Used by mac, ubuntu, and aws plugins.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import yaml from 'js-yaml';
import type { Fix, Stage, FactiiiConfig } from '../../types/index.js';
import { detectPlatform } from '../platform.js';
import { pnpmCommands } from '../commands/index.js';

interface AutoConfig {
  package_manager?: string;
}

/**
 * Create pnpm installation check fix
 *
 * @param stage The stage to check (dev, staging, prod)
 */
export function createPnpmInstallFix(stage: Stage): Fix {
  const platform = detectPlatform();
  const commands = pnpmCommands[platform];
  const id = stage + '-pnpm-missing';
  const stageLabel = stage === 'dev' ? 'locally' : 'on ' + stage + ' server';

  return {
    id,
    stage,
    severity: 'warning',
    description: 'pnpm not installed ' + stageLabel,
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      // For non-dev stages, check if environment is configured
      if (stage !== 'dev') {
        const envConfig = stage === 'prod'
          ? ((config as Record<string, unknown>).prod ?? (config as Record<string, unknown>).production) as Record<string, unknown> | undefined
          : (config as Record<string, unknown>)[stage] as Record<string, unknown> | undefined;
        if (!envConfig?.domain) return false;
      }

      // Only check if project uses pnpm
      const { getStackAutoPath } = await import('../../constants/config-files.js');
      const autoConfigPath = getStackAutoPath(rootDir);
      if (!fs.existsSync(autoConfigPath)) return false;

      try {
        const autoConfig = yaml.load(
          fs.readFileSync(autoConfigPath, 'utf8')
        ) as AutoConfig | null;
        if (autoConfig?.package_manager !== 'pnpm') return false;
      } catch {
        return false;
      }

      try {
        execSync(commands.check, { stdio: 'pipe' });
        return false; // pnpm is installed
      } catch {
        return true; // pnpm is not installed
      }
    },
    fix: commands.install
      ? async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
          console.log('   Installing pnpm...');
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
 * Get all pnpm fixes for a stage
 *
 * @param stage The stage (dev, staging, prod)
 */
export function getPnpmFixes(stage: Stage): Fix[] {
  return [createPnpmInstallFix(stage)];
}
