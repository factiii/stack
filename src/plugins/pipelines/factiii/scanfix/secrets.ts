/**
 * GitHub Secrets fixes for Factiii Pipeline plugin
 * Handles GitHub Secrets validation for secrets stage
 */

import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { GitHubSecretsStore } from '../github-secrets-store.js';

export const secretsFixes: Fix[] = [
  {
    id: 'missing-staging-ssh',
    stage: 'secrets',
    severity: 'critical',
    description: 'STAGING_SSH secret not found in GitHub',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const { extractEnvironments } = await import('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);

      // Only check if staging environment is defined in config
      const hasStagingEnv = environments.staging;
      if (!hasStagingEnv) return false; // Skip check if staging not configured

      const store = new GitHubSecretsStore({});
      const result = await store.checkSecrets(['STAGING_SSH']);
      return result.missing?.includes('STAGING_SSH') ?? false;
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // This requires interactive prompting - handled by fix.js
      console.log('   Please provide STAGING_SSH key when prompted');
      return false; // Return false to indicate manual intervention needed
    },
    manualFix:
      'Add STAGING_SSH secret at: https://github.com/{owner}/{repo}/settings/secrets/actions',
  },
  {
    id: 'missing-prod-ssh',
    stage: 'secrets',
    severity: 'critical',
    description: 'PROD_SSH secret not found in GitHub',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const { extractEnvironments } = await import('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);

      // Only check if prod environment is defined in config
      const hasProdEnv = environments.prod;
      if (!hasProdEnv) return false; // Skip check if prod not configured

      const store = new GitHubSecretsStore({});
      const result = await store.checkSecrets(['PROD_SSH']);
      return result.missing?.includes('PROD_SSH') ?? false;
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      console.log('   Please provide PROD_SSH key when prompted');
      return false;
    },
    manualFix:
      'Add PROD_SSH secret at: https://github.com/{owner}/{repo}/settings/secrets/actions',
  },
  {
    id: 'missing-aws-secret',
    stage: 'secrets',
    severity: 'warning',
    description: 'AWS_SECRET_ACCESS_KEY not found in GitHub (needed for ECR)',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const { extractEnvironments } = await import('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);

      // Check if any environment uses AWS
      const hasAwsEnv = Object.values(environments).some(env =>
        env.server === 'aws' && env.access_key_id
      );
      if (!hasAwsEnv) return false;

      const store = new GitHubSecretsStore({});
      const result = await store.checkSecrets(['AWS_SECRET_ACCESS_KEY']);
      return result.missing?.includes('AWS_SECRET_ACCESS_KEY') ?? false;
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      console.log('   Please provide AWS_SECRET_ACCESS_KEY when prompted');
      return false;
    },
    manualFix:
      'Add AWS_SECRET_ACCESS_KEY secret at: https://github.com/{owner}/{repo}/settings/secrets/actions',
  },
];

