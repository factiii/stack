/**
 * Configuration-related fixes for AWS plugin
 * Handles configuration checks and validation
 */

import { execSync } from 'child_process';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { isOnServer } from '../utils/aws-helpers.js';

export const configFixes: Fix[] = [
  // PROD STAGE FIXES
  {
    id: 'prod-domain-missing',
    stage: 'prod',
    severity: 'critical',
    description: '🌐 Production domain not configured in stack.yml',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (isOnServer()) return false;
      const { extractEnvironments } = await import('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);

      // Only check if prod environment is defined in config
      const hasProdEnv = environments.prod || environments.production;
      if (!hasProdEnv) return false; // Skip check if prod not configured

      return !environments.prod?.domain && !environments.production?.domain;
    },
    fix: null,
    manualFix: 'Add prod.domain to stack.yml',
  },
  {
    id: 'prod-aws-config-missing',
    stage: 'prod',
    severity: 'critical',
    description: '☁️ AWS configuration missing in stack.yml',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (isOnServer()) return false;
      const { extractEnvironments } = await import('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);

      // Only check if prod environment is defined in config
      const hasProdEnv = environments.prod || environments.production;
      if (!hasProdEnv) return false; // Skip check if prod not configured

      const prodEnv = environments.prod ?? environments.production;
      return !prodEnv?.access_key_id || !prodEnv?.region;
    },
    fix: null,
    manualFix: 'Add access_key_id and region to prod environment in stack.yml',
  },
  {
    id: 'prod-unreachable',
    stage: 'prod',
    severity: 'critical',
    description: '🌐 Cannot reach production server',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (isOnServer()) return false;
      const { extractEnvironments } = await import('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);

      // Only check if prod environment is defined in config
      const hasProdEnv = environments.prod || environments.production;
      if (!hasProdEnv) return false; // Skip check if prod not configured

      const domain = environments.prod?.domain ?? environments.production?.domain;
      if (!domain) return false;

      try {
        execSync(`ping -c 1 -W 3 ${domain}`, { stdio: 'pipe' });
        return false;
      } catch {
        return true;
      }
    },
    fix: null,
    manualFix: 'Check network connectivity to production server',
  },
];

