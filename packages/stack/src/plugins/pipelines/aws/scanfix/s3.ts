/**
 * AWS S3 Fixes
 *
 * Provisions S3 bucket with encryption and blocked public access.
 * Configures CORS for the production domain.
 * Uses AWS SDK v3.
 */

import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import {
  getAwsConfig,
  getProjectName,
  getResourceNames,
  isAwsConfigured,
  getAwsAccountId,
  findBucket,
  hasCors,
  getS3Client,
  confirmAwsAction,
  CreateBucketCommand,
  PutPublicAccessBlockCommand,
  PutBucketEncryptionCommand,
  PutBucketCorsCommand,
} from '../utils/aws-helpers.js';

/**
 * Get a globally unique S3 bucket name.
 * Honors `aws.s3_bucket` override first (lets you adopt an existing bucket
 * whose name doesn't follow the convention).
 * Otherwise tries `factiii-{project}` then `factiii-{project}-{accountId}`.
 */
async function resolveBucketName(config: FactiiiConfig, projectName: string, region: string): Promise<string> {
  const override = getResourceNames(config).s3Bucket;
  if (override) return override;
  const simpleName = 'factiii-' + projectName;
  if (await findBucket(simpleName, region)) return simpleName; // Already ours
  // Try simple name first, use account-scoped name as fallback
  const accountId = await getAwsAccountId(region);
  return accountId ? simpleName + '-' + accountId : simpleName;
}

export const s3Fixes: Fix[] = [
  {
    id: 'aws-s3-bucket-missing',
    stage: 'prod',
    severity: 'warning',
    description: '🪣 S3 bucket not created for file storage',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const bucketName = await resolveBucketName(config, projectName, region);
      return !(await findBucket(bucketName, region));
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const bucketName = await resolveBucketName(config, projectName, region);

      const ok = await confirmAwsAction(
        'Create S3 bucket "' + bucketName + '" in ' + region + '\n' +
        '  - Public access: blocked\n' +
        '  - Encryption: AES-256 server-side'
      );
      if (!ok) {
        console.log('   [--] Skipped — no S3 bucket created');
        return false;
      }

      try {
        const s3 = getS3Client(region);

        // Create bucket (us-east-1 doesn't need LocationConstraint)
        if (region === 'us-east-1') {
          await s3.send(new CreateBucketCommand({ Bucket: bucketName }));
        } else {
          await s3.send(new CreateBucketCommand({
            Bucket: bucketName,
            CreateBucketConfiguration: { LocationConstraint: region as any },
          }));
        }
        console.log('   Created S3 bucket: ' + bucketName);

        // Block all public access
        await s3.send(new PutPublicAccessBlockCommand({
          Bucket: bucketName,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        }));
        console.log('   Blocked all public access');

        // Enable server-side encryption (AES-256)
        await s3.send(new PutBucketEncryptionCommand({
          Bucket: bucketName,
          ServerSideEncryptionConfiguration: {
            Rules: [{
              ApplyServerSideEncryptionByDefault: {
                SSEAlgorithm: 'AES256',
              },
            }],
          },
        }));
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
    description: '🪣 S3 bucket CORS not configured for production domain',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const bucketName = await resolveBucketName(config, projectName, region);
      if (!(await findBucket(bucketName, region))) return false;
      return !(await hasCors(bucketName, region));
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const bucketName = await resolveBucketName(config, projectName, region);

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { extractEnvironments } = require('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);
      const prodEnv = environments.prod ?? environments.production;
      const domain = prodEnv?.domain;

      if (!domain || domain.toUpperCase().startsWith('EXAMPLE')) {
        console.log('   Set production domain in stack.yml first');
        return false;
      }

      const ok = await confirmAwsAction(
        'Update S3 bucket CORS for "' + bucketName + '"\n' +
        '  - Allowed origin: https://' + domain + '\n' +
        '  - Methods: GET, PUT, POST, DELETE'
      );
      if (!ok) {
        console.log('   [--] Skipped — CORS unchanged');
        return false;
      }

      try {
        const s3 = getS3Client(region);

        await s3.send(new PutBucketCorsCommand({
          Bucket: bucketName,
          CORSConfiguration: {
            CORSRules: [{
              AllowedHeaders: ['*'],
              AllowedMethods: ['GET', 'PUT', 'POST', 'DELETE'],
              AllowedOrigins: ['https://' + domain],
              MaxAgeSeconds: 3600,
            }],
          },
        }));
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
