/**
 * AWS CLI fixes for AWS plugin
 * Handles AWS CLI installation for dev environment
 */

import { execSync } from 'child_process';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';

export const awsCliFixes: Fix[] = [
  {
    id: 'aws-cli-not-installed-dev',
    stage: 'dev',
    severity: 'warning',
    description: 'AWS CLI not installed (needed for ECR)',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // Only check if AWS is configured
      if (!config?.aws?.access_key_id) return false;

      try {
        execSync('which aws', { stdio: 'pipe' });
        return false;
      } catch {
        return true;
      }
    },
    fix: null,
    manualFix: 'Install AWS CLI: brew install awscli',
  },
];

