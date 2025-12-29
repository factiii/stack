/**
 * Configuration-related fixes for AWS plugin
 * Handles configuration checks and validation
 */

import { execSync } from 'child_process';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';

export const configFixes: Fix[] = [
  // PROD STAGE FIXES
  {
    id: 'prod-host-missing',
    stage: 'prod',
    severity: 'critical',
    description: 'Production host not configured in factiii.yml',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // Only check if prod environment is defined in config
      const hasProdEnv =
        config?.environments?.prod || config?.environments?.production;
      if (!hasProdEnv) return false; // Skip check if prod not configured

      return (
        !config?.environments?.prod?.host && !config?.environments?.production?.host
      );
    },
    fix: null,
    manualFix: 'Add environments.prod.host to factiii.yml',
  },
  {
    id: 'prod-aws-config-missing',
    stage: 'prod',
    severity: 'critical',
    description: 'AWS configuration missing in factiii.yml',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // Only check if prod environment is defined in config
      const hasProdEnv =
        config?.environments?.prod || config?.environments?.production;
      if (!hasProdEnv) return false; // Skip check if prod not configured

      return !config?.aws?.access_key_id || !config?.aws?.region;
    },
    fix: null,
    manualFix: 'Add aws.access_key_id and aws.region to factiii.yml',
  },
  {
    id: 'prod-unreachable',
    stage: 'prod',
    severity: 'critical',
    description: 'Cannot reach production server',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // Only check if prod environment is defined in config
      const hasProdEnv =
        config?.environments?.prod || config?.environments?.production;
      if (!hasProdEnv) return false; // Skip check if prod not configured

      const host =
        config?.environments?.prod?.host ?? config?.environments?.production?.host;
      if (!host) return false;

      try {
        execSync(`ping -c 1 -W 3 ${host}`, { stdio: 'pipe' });
        return false;
      } catch {
        return true;
      }
    },
    fix: null,
    manualFix: 'Check network connectivity to production server',
  },
  {
    id: 'prod-repo-not-cloned',
    stage: 'prod',
    severity: 'warning',
    description: 'Repository not cloned on production server',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const envConfig =
        config?.environments?.prod ?? config?.environments?.production;
      if (!envConfig) return false;
      if (!envConfig?.host) return false;

      const repoName = config.name ?? 'app';

      // Executed locally - SSH handled by CLI wrapper
      const fs = await import('fs');
      const path = await import('path');
      try {
        const repoPath = path.join(process.env.HOME ?? '/home/ubuntu', '.factiii', repoName, '.git');
        return !fs.existsSync(repoPath);
      } catch {
        return true;
      }
    },
    fix: null, // Will be handled by ensureServerReady()
    manualFix: 'Repository will be cloned automatically on first deployment',
  },
];

