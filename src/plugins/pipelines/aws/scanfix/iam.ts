/**
 * AWS IAM Fixes
 *
 * Creates IAM users with scoped policies:
 * - Dev user: read-only access for development
 * - Prod user: full access for deployment
 * Uses AWS SDK v3.
 */

import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import {
  getAwsConfig,
  getProjectName,
  isAwsConfigured,
  findIamUser,
  getAwsAccountId,
  getIAMClient,
  CreateUserCommand,
  PutUserPolicyCommand,
  CreateAccessKeyCommand,
} from '../utils/aws-helpers.js';

/**
 * Generate dev IAM policy (read-only)
 */
function getDevPolicy(projectName: string, region: string, accountId: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'ECRReadOnly',
        Effect: 'Allow',
        Action: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchGetImage',
          'ecr:GetDownloadUrlForLayer',
          'ecr:DescribeRepositories',
          'ecr:ListImages',
        ],
        Resource: 'arn:aws:ecr:' + region + ':' + accountId + ':repository/' + projectName,
      },
      {
        Sid: 'ECRAuth',
        Effect: 'Allow',
        Action: 'ecr:GetAuthorizationToken',
        Resource: '*',
      },
      {
        Sid: 'S3ReadOnly',
        Effect: 'Allow',
        Action: [
          's3:GetObject',
          's3:ListBucket',
        ],
        Resource: [
          'arn:aws:s3:::factiii-' + projectName,
          'arn:aws:s3:::factiii-' + projectName + '/*',
        ],
      },
      {
        Sid: 'EC2Describe',
        Effect: 'Allow',
        Action: [
          'ec2:DescribeInstances',
          'ec2:DescribeVpcs',
          'ec2:DescribeSubnets',
          'ec2:DescribeSecurityGroups',
          'ec2:DescribeKeyPairs',
        ],
        Resource: '*',
      },
      {
        Sid: 'RDSDescribe',
        Effect: 'Allow',
        Action: [
          'rds:DescribeDBInstances',
          'rds:DescribeDBSubnetGroups',
        ],
        Resource: '*',
      },
    ],
  });
}

/**
 * Generate prod IAM policy (full access for deployment)
 */
function getProdPolicy(projectName: string, region: string, accountId: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'ECRFullAccess',
        Effect: 'Allow',
        Action: 'ecr:*',
        Resource: 'arn:aws:ecr:' + region + ':' + accountId + ':repository/' + projectName,
      },
      {
        Sid: 'ECRAuth',
        Effect: 'Allow',
        Action: 'ecr:GetAuthorizationToken',
        Resource: '*',
      },
      {
        Sid: 'S3FullAccess',
        Effect: 'Allow',
        Action: 's3:*',
        Resource: [
          'arn:aws:s3:::factiii-' + projectName,
          'arn:aws:s3:::factiii-' + projectName + '/*',
        ],
      },
      {
        Sid: 'EC2Management',
        Effect: 'Allow',
        Action: [
          'ec2:DescribeInstances',
          'ec2:StartInstances',
          'ec2:StopInstances',
          'ec2:RebootInstances',
          'ec2:DescribeVpcs',
          'ec2:DescribeSubnets',
          'ec2:DescribeSecurityGroups',
          'ec2:DescribeAddresses',
          'ec2:CreateKeyPair',
          'ec2:DescribeKeyPairs',
          'ec2:DeleteKeyPair',
          'ec2:ImportKeyPair',
        ],
        Resource: '*',
      },
      {
        Sid: 'RDSManagement',
        Effect: 'Allow',
        Action: [
          'rds:DescribeDBInstances',
          'rds:StartDBInstance',
          'rds:StopDBInstance',
          'rds:RebootDBInstance',
          'rds:CreateDBSnapshot',
          'rds:DescribeDBSnapshots',
        ],
        Resource: '*',
      },
      {
        Sid: 'SESFullAccess',
        Effect: 'Allow',
        Action: 'ses:*',
        Resource: '*',
      },
    ],
  });
}

export const iamFixes: Fix[] = [
  {
    id: 'aws-iam-dev-user-missing',
    stage: 'secrets',
    severity: 'warning',
    description: '👤 IAM dev user not created (read-only access for dev workflows)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      return !(await findIamUser('factiii-' + projectName + '-dev', region));
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const userName = 'factiii-' + projectName + '-dev';

      console.log('');
      console.log('   ============================================================');
      console.log('   CREATE IAM DEV USER');
      console.log('   ============================================================');
      console.log('   Will create IAM user "' + userName + '" with read-only policy:');
      console.log('   - ECR: pull images, list repositories');
      console.log('   - S3: read objects from project bucket');
      console.log('   - EC2/RDS: describe (view) resources');
      console.log('');
      console.log('   This user is for local development and CI read-only access.');
      console.log('   ============================================================');
      console.log('');

      const { confirm } = await import('../../../../utils/secret-prompts.js');
      const proceed = await confirm('   Create IAM dev user "' + userName + '"?', true);

      if (!proceed) {
        console.log('   [--] Skipped — you can create it later with: npx stack fix --secrets');
        return true;
      }

      try {
        const iam = getIAMClient(region);

        // Get account ID for ARNs
        const accountId = await getAwsAccountId(region);
        if (!accountId) {
          console.log('   Could not get AWS account ID');
          return false;
        }

        // Create IAM user
        await iam.send(new CreateUserCommand({ UserName: userName }));
        console.log('   Created IAM user: ' + userName);

        // Create and attach inline policy
        const policy = getDevPolicy(projectName, region, accountId);
        await iam.send(new PutUserPolicyCommand({
          UserName: userName,
          PolicyName: 'factiii-' + projectName + '-dev-policy',
          PolicyDocument: policy,
        }));
        console.log('   Attached dev policy (read-only ECR, S3, EC2, RDS)');

        // Create access key
        const keyResult = await iam.send(new CreateAccessKeyCommand({ UserName: userName }));
        const accessKeyId = keyResult.AccessKey?.AccessKeyId;
        const secretKey = keyResult.AccessKey?.SecretAccessKey;

        console.log('');
        console.log('   Dev credentials (save these!):');
        console.log('   Access Key ID: ' + accessKeyId);
        console.log('   Secret Access Key: ' + secretKey);
        console.log('');
        console.log('   TIP: Store in Ansible Vault: npx stack deploy --secrets edit');

        return true;
      } catch (e) {
        console.log('   Failed to create dev IAM user: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: [
      '============================================================',
      'IAM DEV USER SETUP',
      '============================================================',
      '',
      '  This creates a read-only IAM user for local dev and CI.',
      '  Permissions: ECR pull, S3 read, EC2/RDS describe.',
      '',
      '  Auto-fix:  npx stack fix --secrets  (creates user + policy + access key)',
      '',
      '  Or manually in AWS Console:',
      '  1. Go to IAM > Users > Create user',
      '  2. Name: factiii-{project}-dev',
      '  3. Attach inline policy with read-only ECR, S3, EC2, RDS access',
      '  4. Create access key: User > Security credentials > Create access key > CLI',
      '  5. Store secret in vault: npx stack deploy --secrets set AWS_DEV_SECRET_ACCESS_KEY',
      '',
      '============================================================',
    ].join('\n'),
  },
  {
    id: 'aws-iam-prod-user-missing',
    stage: 'secrets',
    severity: 'warning',
    description: '👤 IAM prod user not created (deployment access for staging/prod)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      return !(await findIamUser('factiii-' + projectName + '-prod', region));
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const userName = 'factiii-' + projectName + '-prod';

      console.log('');
      console.log('   ============================================================');
      console.log('   CREATE IAM PROD USER');
      console.log('   ============================================================');
      console.log('   Will create IAM user "' + userName + '" with deployment policy:');
      console.log('   - ECR: full access (push/pull images)');
      console.log('   - S3: full access to project bucket');
      console.log('   - EC2: describe + start/stop/reboot instances');
      console.log('   - RDS: describe + start/stop/reboot + snapshots');
      console.log('   - SES: full email sending access');
      console.log('');
      console.log('   This user is for CI/CD pipelines and production deployments.');
      console.log('   ============================================================');
      console.log('');

      const { confirm } = await import('../../../../utils/secret-prompts.js');
      const proceed = await confirm('   Create IAM prod user "' + userName + '"?', true);

      if (!proceed) {
        console.log('   [--] Skipped — you can create it later with: npx stack fix --secrets');
        return true;
      }

      try {
        const iam = getIAMClient(region);

        // Get account ID for ARNs
        const accountId = await getAwsAccountId(region);
        if (!accountId) {
          console.log('   Could not get AWS account ID');
          return false;
        }

        // Create IAM user
        await iam.send(new CreateUserCommand({ UserName: userName }));
        console.log('   Created IAM user: ' + userName);

        // Create and attach inline policy
        const policy = getProdPolicy(projectName, region, accountId);
        await iam.send(new PutUserPolicyCommand({
          UserName: userName,
          PolicyName: 'factiii-' + projectName + '-prod-policy',
          PolicyDocument: policy,
        }));
        console.log('   Attached prod policy (full ECR, S3, EC2, RDS, SES)');

        // Create access key
        const keyResult = await iam.send(new CreateAccessKeyCommand({ UserName: userName }));
        const accessKeyId = keyResult.AccessKey?.AccessKeyId;
        const secretKey = keyResult.AccessKey?.SecretAccessKey;

        console.log('');
        console.log('   Prod credentials (save these!):');
        console.log('   Access Key ID: ' + accessKeyId);
        console.log('   Secret Access Key: ' + secretKey);
        console.log('');
        console.log('   TIP: Store in Ansible Vault: npx stack deploy --secrets edit');

        return true;
      } catch (e) {
        console.log('   Failed to create prod IAM user: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: [
      '============================================================',
      'IAM PROD USER SETUP',
      '============================================================',
      '',
      '  This creates a deployment IAM user for CI/CD and prod deploys.',
      '  Permissions: ECR full, S3 full, EC2/RDS manage, SES send.',
      '',
      '  Auto-fix:  npx stack fix --secrets  (creates user + policy + access key)',
      '',
      '  Or manually in AWS Console:',
      '  1. Go to IAM > Users > Create user',
      '  2. Name: factiii-{project}-prod',
      '  3. Attach inline policy with ECR, S3, EC2, RDS, SES access',
      '  4. Create access key: User > Security credentials > Create access key > CLI',
      '  5. Store secret in vault: npx stack deploy --secrets set AWS_PROD_SECRET_ACCESS_KEY',
      '',
      '============================================================',
    ].join('\n'),
  },
];
