/**
 * AWS ECR Fixes
 *
 * Provisions ECR (Elastic Container Registry) repository
 * with lifecycle policy to keep costs down.
 * Uses AWS SDK v3.
 */

import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import {
  getAwsConfig,
  getResourceNames,
  isAwsConfigured,
  findEcrRepo,
  getECRClient,
  confirmAwsAction,
  CreateRepositoryCommand,
  PutLifecyclePolicyCommand,
  GetAuthorizationTokenCommand,
} from '../utils/aws-helpers.js';

export const ecrFixes: Fix[] = [
  {
    id: 'aws-ecr-repo-missing',
    stage: 'prod',
    severity: 'warning',
    description: '📦 ECR repository not created for container images',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const repoName = getResourceNames(config).ecrRepository;
      return !(await findEcrRepo(repoName, region));
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const repoName = getResourceNames(config).ecrRepository;

      const ok = await confirmAwsAction(
        'Create ECR repository "' + repoName + '" in ' + region + '\n' +
        '  - Image scanning on push: enabled\n' +
        '  - Lifecycle policy: keep latest 10 images'
      );
      if (!ok) {
        console.log('   [--] Skipped — no ECR repository created');
        return false;
      }

      try {
        const ecr = getECRClient(region);

        // Create ECR repository
        const result = await ecr.send(new CreateRepositoryCommand({
          repositoryName: repoName,
          imageScanningConfiguration: { scanOnPush: true },
        }));
        const repoUri = result.repository?.repositoryUri;
        console.log('   Created ECR repository: ' + repoName);
        if (repoUri) {
          console.log('   Repository URI: ' + repoUri);
        }

        // Set lifecycle policy to keep only 10 images
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

        await ecr.send(new PutLifecyclePolicyCommand({
          repositoryName: repoName,
          lifecyclePolicyText: lifecyclePolicy,
        }));
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
    description: '📦 ECR Docker login not working from dev machine',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const repoName = getResourceNames(config).ecrRepository;
      if (!(await findEcrRepo(repoName, region))) return false;

      // Test ECR authorization token
      try {
        const ecr = getECRClient(region);
        const result = await ecr.send(new GetAuthorizationTokenCommand({}));
        return !(result.authorizationData?.length);
      } catch {
        return true;
      }
    },
    fix: null,
    manualFix: 'Test ECR login: aws ecr get-login-password --region <region> | docker login --username AWS --password-stdin <account-id>.dkr.ecr.<region>.amazonaws.com',
  },
];
