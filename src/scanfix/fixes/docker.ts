/**
 * Shared Docker Fixes
 *
 * Platform-aware Docker installation and running status checks.
 * Used by mac, ubuntu, and aws plugins.
 */

import { execSync } from 'child_process';
import type { Fix, Stage, FactiiiConfig } from '../../types/index.js';
import { detectPlatform } from '../platform.js';
import { dockerCommands } from '../commands/index.js';

/**
 * Create Docker installation check fix
 *
 * @param stage The stage to check (dev, staging, prod)
 * @param idPrefix Optional prefix for fix ID (e.g., 'aws')
 */
export function createDockerInstallFix(stage: Stage, idPrefix?: string): Fix {
  const platform = detectPlatform();
  const commands = dockerCommands[platform];
  const id = idPrefix ? idPrefix + '-docker-not-installed' : stage + '-docker-missing';
  const stageLabel = stage === 'dev' ? 'locally' : 'on ' + stage + ' server';

  return {
    id,
    stage,
    severity: 'critical',
    description: 'Docker is not installed ' + stageLabel,
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // For non-dev stages, check if environment is configured with a real domain
      if (stage !== 'dev') {
        const envConfig = stage === 'prod'
          ? ((config as Record<string, unknown>).prod ?? (config as Record<string, unknown>).production) as Record<string, unknown> | undefined
          : (config as Record<string, unknown>)[stage] as Record<string, unknown> | undefined;
        if (!envConfig?.domain) return false;
        // Skip if domain is still a placeholder
        if (typeof envConfig.domain === 'string' && envConfig.domain.toUpperCase().startsWith('EXAMPLE')) return false;
      }

      try {
        execSync(commands.check, { stdio: 'pipe' });
        return false; // Docker is installed
      } catch {
        return true; // Docker is not installed
      }
    },
    fix: commands.install
      ? async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
          console.log('   Installing Docker...');
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
 * Create Docker running check fix
 *
 * @param stage The stage to check (dev, staging, prod)
 * @param idPrefix Optional prefix for fix ID (e.g., 'aws')
 */
export function createDockerRunningFix(stage: Stage, idPrefix?: string): Fix {
  const platform = detectPlatform();
  const commands = dockerCommands[platform];
  const id = idPrefix ? idPrefix + '-docker-not-running' : stage + '-docker-not-running';
  const stageLabel = stage === 'dev' ? 'locally' : 'on ' + stage + ' server';

  return {
    id,
    stage,
    severity: 'critical',
    description: 'Docker is not running ' + stageLabel,
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // For non-dev stages, check if environment is configured with a real domain
      if (stage !== 'dev') {
        const envConfig = stage === 'prod'
          ? ((config as Record<string, unknown>).prod ?? (config as Record<string, unknown>).production) as Record<string, unknown> | undefined
          : (config as Record<string, unknown>)[stage] as Record<string, unknown> | undefined;
        if (!envConfig?.domain) return false;
        // Skip if domain is still a placeholder
        if (typeof envConfig.domain === 'string' && envConfig.domain.toUpperCase().startsWith('EXAMPLE')) return false;
      }

      try {
        execSync('docker info', { stdio: 'pipe' });
        return false; // Docker is running
      } catch {
        return true; // Docker is not running
      }
    },
    fix: commands.start
      ? async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
          // Double-check Docker isn't already running
          try {
            execSync('docker info', { stdio: 'pipe' });
            console.log('   Docker is already running');
            return true;
          } catch {
            // Docker not running, proceed to start it
          }

          console.log('   Starting Docker...');
          try {
            execSync(commands.start!, { stdio: 'inherit' });

            // Wait for Docker to start (up to 30 seconds)
            for (let i = 0; i < 30; i++) {
              await new Promise(resolve => setTimeout(resolve, 1000));
              try {
                execSync('docker info', { stdio: 'pipe' });
                console.log('   Docker started successfully');
                return true;
              } catch {
                // Still starting...
              }
            }

            console.log('   Docker is starting (may take a minute)...');
            return true;
          } catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            console.log('   Failed to start Docker: ' + errorMessage);
            return false;
          }
        }
      : null,
    manualFix: commands.start ? 'Start Docker: ' + commands.start : commands.manualFix,
  };
}

/**
 * Get all Docker fixes for a stage
 *
 * @param stage The stage (dev, staging, prod)
 * @param idPrefix Optional prefix for fix IDs
 */
export function getDockerFixes(stage: Stage, idPrefix?: string): Fix[] {
  return [
    createDockerInstallFix(stage, idPrefix),
    createDockerRunningFix(stage, idPrefix),
  ];
}
