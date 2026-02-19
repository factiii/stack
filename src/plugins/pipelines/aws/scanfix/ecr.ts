/**
 * AWS ECR Fixes
 *
 * Provisions ECR (Elastic Container Registry) repository
 * with lifecycle policy to keep costs down.
 */

import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { awsExec, awsExecSafe, getAwsConfig, getProjectName, isOnServer } from '../utils/aws-helpers.js';

/**
 * Check if ECR repository exists
 */
function findEcrRepo(repoName: string, region: string): boolean {
  const result = awsExecSafe(
    'aws ecr describe-repositories --repository-names ' + repoName,
    region
  );
  return !!result && !result.includes('RepositoryNotFoundException');
}

/**
 * Check if AWS is configured for this project
 */
function isAwsConfigured(config: FactiiiConfig): boolean {
  if (isOnServer()) return false;
  if (config.aws) return true;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { extractEnvironments } = require('../../../../utils/config-helpers.js');
  const environments = extractEnvironments(config);
  return Object.values(environments).some(
    (e: unknown) => (e as { pipeline?: string }).pipeline === 'aws'
  );
}

export const ecrFixes: Fix[] = [
  {
    id: 'aws-ecr-repo-missing',
    stage: 'prod',
    severity: 'warning',
    description: 'ECR repository not created for container images',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      return !findEcrRepo(projectName, region);
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);

      try {
        // Create ECR repository
        const result = awsExec(
          'aws ecr create-repository --repository-name ' + projectName +
          ' --image-scanning-configuration scanOnPush=true',
          region
        );
        const parsed = JSON.parse(result);
        const repoUri = parsed.repository?.repositoryUri;
        console.log('   Created ECR repository: ' + projectName);
        if (repoUri) {
          console.log('   Repository URI: ' + repoUri);
        }

        // Set lifecycle policy to keep only 10 images (control costs)
        const lifecyclePolicy = JSON.stringify({
          rules: [{
            rulePriority: 1,
            description: 'Keep only 10 images',
            selection: {
              tagStatus: 'any',
              countType: 'imageCountMoreThan',
              countNumber: 10,
            },
            action: { type: 'expire' },
          }],
        });

        awsExec(
          'aws ecr put-lifecycle-policy --repository-name ' + projectName +
          " --lifecycle-policy-text '" + lifecyclePolicy + "'",
          region
        );
        console.log('   Set lifecycle policy: keep 10 most recent images');

        return true;
      } catch (e) {
        console.log('   Failed to create ECR repository: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Create ECR repository: aws ecr create-repository --repository-name <app-name>',
  },
  {
    id: 'aws-ecr-login-test',
    stage: 'dev',
    severity: 'info',
    description: 'ECR Docker login not working from dev machine',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      if (!findEcrRepo(projectName, region)) return false;

      // Test ECR login
      const result = awsExecSafe(
        'aws ecr get-login-password',
        region
      );
      return !result;
    },
    fix: null,
    manualFix: 'Test ECR login: aws ecr get-login-password --region <region> | docker login --username AWS --password-stdin <account-id>.dkr.ecr.<region>.amazonaws.com',
  },
];
