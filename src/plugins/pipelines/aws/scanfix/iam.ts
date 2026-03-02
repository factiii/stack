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
    description: '👤 IAM dev user not created (read-only access)',
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
    manualFix: 'Create IAM dev user with read-only policy for ECR, S3, EC2, RDS',
  },
  {
    id: 'aws-iam-prod-user-missing',
    stage: 'secrets',
    severity: 'warning',
    description: '👤 IAM prod user not created (deployment access)',
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
    manualFix: 'Create IAM prod user with deployment policy for ECR, S3, EC2, RDS, SES',
  },
];
