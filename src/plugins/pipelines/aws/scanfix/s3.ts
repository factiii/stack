/**
 * AWS S3 Fixes
 *
 * Provisions S3 bucket with encryption and blocked public access.
 * Configures CORS for the production domain.
 */

import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { awsExec, awsExecSafe, getAwsConfig, getProjectName } from '../utils/aws-helpers.js';

/**
 * Check if S3 bucket exists
 */
function findBucket(bucketName: string, region: string): boolean {
  const result = awsExecSafe(
    'aws s3api head-bucket --bucket ' + bucketName,
    region
  );
  // head-bucket returns empty on success, throws on failure
  return result !== null;
}

/**
 * Check if CORS is configured on bucket
 */
function hasCors(bucketName: string, region: string): boolean {
  const result = awsExecSafe(
    'aws s3api get-bucket-cors --bucket ' + bucketName,
    region
  );
  return !!result && result !== 'null';
}

/**
 * Check if AWS is configured for this project
 */
function isAwsConfigured(config: FactiiiConfig): boolean {
  if (config.aws) return true;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { extractEnvironments } = require('../../../../utils/config-helpers.js');
  const environments = extractEnvironments(config);
  return Object.values(environments).some(
    (e: unknown) => (e as { pipeline?: string }).pipeline === 'aws'
  );
}

export const s3Fixes: Fix[] = [
  {
    id: 'aws-s3-bucket-missing',
    stage: 'prod',
    severity: 'warning',
    description: 'S3 bucket not created for file storage',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const bucketName = 'factiii-' + projectName;
      return !findBucket(bucketName, region);
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const bucketName = 'factiii-' + projectName;

      try {
        // Create bucket (us-east-1 doesn't need LocationConstraint)
        if (region === 'us-east-1') {
          awsExec(
            'aws s3api create-bucket --bucket ' + bucketName,
            region
          );
        } else {
          awsExec(
            'aws s3api create-bucket --bucket ' + bucketName +
            ' --create-bucket-configuration LocationConstraint=' + region,
            region
          );
        }
        console.log('   Created S3 bucket: ' + bucketName);

        // Block all public access
        awsExec(
          'aws s3api put-public-access-block --bucket ' + bucketName +
          ' --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true',
          region
        );
        console.log('   Blocked all public access');

        // Enable server-side encryption (AES-256)
        awsExec(
          'aws s3api put-bucket-encryption --bucket ' + bucketName +
          ' --server-side-encryption-configuration ' +
          '"{\\\"Rules\\\":[{\\\"ApplyServerSideEncryptionByDefault\\\":{\\\"SSEAlgorithm\\\":\\\"AES256\\\"}}]}"',
          region
        );
        console.log('   Enabled AES-256 encryption');

        return true;
      } catch (e) {
        console.log('   Failed to create S3 bucket: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Create S3 bucket with encryption and blocked public access',
  },
  {
    id: 'aws-s3-cors-missing',
    stage: 'prod',
    severity: 'info',
    description: 'S3 bucket CORS not configured for production domain',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const bucketName = 'factiii-' + projectName;
      if (!findBucket(bucketName, region)) return false;
      return !hasCors(bucketName, region);
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const bucketName = 'factiii-' + projectName;

      // Get production domain for CORS
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { extractEnvironments } = require('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);
      const prodEnv = environments.prod ?? environments.production;
      const domain = prodEnv?.domain;

      if (!domain || domain.startsWith('EXAMPLE-')) {
        console.log('   Set production domain in factiii.yml first');
        return false;
      }

      try {
        const corsConfig = JSON.stringify({
          CORSRules: [{
            AllowedHeaders: ['*'],
            AllowedMethods: ['GET', 'PUT', 'POST', 'DELETE'],
            AllowedOrigins: ['https://' + domain],
            MaxAgeSeconds: 3600,
          }],
        });

        awsExec(
          'aws s3api put-bucket-cors --bucket ' + bucketName +
          " --cors-configuration '" + corsConfig + "'",
          region
        );
        console.log('   Configured CORS for https://' + domain);
        return true;
      } catch (e) {
        console.log('   Failed to configure CORS: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Configure S3 CORS to allow requests from your production domain',
  },
];
