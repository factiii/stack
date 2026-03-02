/**
 * AWS Helper Utilities
 *
 * Shared functions for AWS SDK operations used across all AWS scanfix files.
 * Uses AWS SDK v3 clients instead of AWS CLI.
 */

import {
  EC2Client,
  DescribeVpcsCommand,
  DescribeSubnetsCommand,
  DescribeSecurityGroupsCommand,
  DescribeInstancesCommand,
  DescribeKeyPairsCommand,
  DescribeAddressesCommand,
  DescribeInternetGatewaysCommand,
  DescribeAvailabilityZonesCommand,
  DescribeImagesCommand,
  CreateVpcCommand,
  ModifyVpcAttributeCommand,
  CreateSubnetCommand,
  ModifySubnetAttributeCommand,
  CreateInternetGatewayCommand,
  AttachInternetGatewayCommand,
  CreateRouteTableCommand,
  CreateRouteCommand,
  AssociateRouteTableCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  CreateKeyPairCommand,
  RunInstancesCommand,
  AllocateAddressCommand,
  AssociateAddressCommand,
  type Tag,
  type TagSpecification,
  type Filter,
  waitUntilInstanceRunning,
} from '@aws-sdk/client-ec2';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import {
  IAMClient,
  GetUserCommand,
  CreateUserCommand,
  PutUserPolicyCommand,
  CreateAccessKeyCommand,
} from '@aws-sdk/client-iam';
import {
  RDSClient,
  DescribeDBSubnetGroupsCommand,
  CreateDBSubnetGroupCommand,
  DescribeDBInstancesCommand,
  CreateDBInstanceCommand,
} from '@aws-sdk/client-rds';
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutPublicAccessBlockCommand,
  PutBucketEncryptionCommand,
  GetBucketCorsCommand,
  PutBucketCorsCommand,
} from '@aws-sdk/client-s3';
import {
  ECRClient,
  DescribeRepositoriesCommand,
  CreateRepositoryCommand,
  PutLifecyclePolicyCommand,
  GetAuthorizationTokenCommand,
} from '@aws-sdk/client-ecr';
import {
  SESClient,
  VerifyDomainIdentityCommand,
  GetIdentityVerificationAttributesCommand,
  VerifyDomainDkimCommand,
  GetIdentityDkimAttributesCommand,
  GetSendQuotaCommand,
} from '@aws-sdk/client-ses';
import type { FactiiiConfig, EnvironmentConfig } from '../../../../types/index.js';

// ============================================================
// CLIENT FACTORIES — cached per region
// ============================================================

const clientCache: Record<string, unknown> = {};

function getCachedClient<T>(ClientClass: new (config: { region: string }) => T, region: string): T {
  const key = ClientClass.name + ':' + region;
  if (!clientCache[key]) {
    clientCache[key] = new ClientClass({ region });
  }
  return clientCache[key] as T;
}

export function getEC2Client(region: string): EC2Client {
  return getCachedClient(EC2Client, region);
}

export function getSTSClient(region: string): STSClient {
  return getCachedClient(STSClient, region);
}

export function getIAMClient(region: string): IAMClient {
  return getCachedClient(IAMClient, region);
}

export function getRDSClient(region: string): RDSClient {
  return getCachedClient(RDSClient, region);
}

export function getS3Client(region: string): S3Client {
  return getCachedClient(S3Client, region);
}

export function getECRClient(region: string): ECRClient {
  return getCachedClient(ECRClient, region);
}

export function getSESClient(region: string): SESClient {
  return getCachedClient(SESClient, region);
}

// ============================================================
// TAGGING HELPERS
// ============================================================

/**
 * Build standard tags array for AWS resources
 */
export function buildTags(projectName: string, extraTags?: Record<string, string>): Tag[] {
  const tags: Tag[] = [
    { Key: 'factiii:project', Value: projectName },
    { Key: 'factiii:managed', Value: 'true' },
    { Key: 'Name', Value: 'factiii-' + projectName },
  ];
  if (extraTags) {
    for (const [key, value] of Object.entries(extraTags)) {
      tags.push({ Key: key, Value: value });
    }
  }
  return tags;
}

/**
 * Build TagSpecification for resource creation
 */
export function tagSpec(resourceType: string, projectName: string, extraTags?: Record<string, string>): TagSpecification {
  return {
    ResourceType: resourceType as TagSpecification['ResourceType'],
    Tags: buildTags(projectName, extraTags),
  };
}

/**
 * Build a filter for factiii:project tag
 */
export function projectFilter(projectName: string): Filter {
  return { Name: 'tag:factiii:project', Values: [projectName] };
}

// ============================================================
// CONFIG HELPERS
// ============================================================

/**
 * Extract AWS configuration from a FactiiiConfig
 */
export function getAwsConfig(config: FactiiiConfig): {
  region: string;
  configType: string;
  accessKeyId?: string;
} {
  const topLevel = config.aws as Record<string, unknown> | undefined;
  if (topLevel) {
    return {
      region: (topLevel.region as string) ?? 'us-east-1',
      configType: (topLevel.config as string) ?? 'ec2',
      accessKeyId: topLevel.access_key_id as string | undefined,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { extractEnvironments } = require('../../../../utils/config-helpers.js');
  const environments = extractEnvironments(config) as Record<string, EnvironmentConfig>;
  for (const env of Object.values(environments)) {
    if (env.pipeline === 'aws' || env.access_key_id) {
      return {
        region: env.region ?? 'us-east-1',
        configType: env.config ?? 'ec2',
        accessKeyId: env.access_key_id,
      };
    }
  }

  return { region: 'us-east-1', configType: 'ec2' };
}

/**
 * Check if running on server (skip AWS provisioning)
 */
export function isOnServer(): boolean {
  return process.env.FACTIII_ON_SERVER === 'true' || process.env.GITHUB_ACTIONS === 'true';
}

/**
 * Get project name for tagging
 */
export function getProjectName(config: FactiiiConfig): string {
  return config.name ?? 'app';
}

/**
 * Get AWS account ID via STS
 */
export async function getAwsAccountId(region: string): Promise<string | null> {
  try {
    const sts = getSTSClient(region);
    const result = await sts.send(new GetCallerIdentityCommand({}));
    return result.Account ?? null;
  } catch {
    return null;
  }
}

/**
 * Get ECR authorization token via SDK (runs on dev machine).
 * Returns credentials for docker login — no AWS CLI needed on server.
 * Token is valid for 12 hours.
 */
export async function getEcrAuthToken(region: string): Promise<{
  username: string;
  password: string;
  proxyEndpoint: string;
} | null> {
  try {
    const ecr = getECRClient(region);
    const result = await ecr.send(new GetAuthorizationTokenCommand({}));
    const authData = result.authorizationData?.[0];
    if (!authData?.authorizationToken || !authData?.proxyEndpoint) return null;

    // Token is base64-encoded "username:password"
    const decoded = Buffer.from(authData.authorizationToken, 'base64').toString('utf8');
    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) return null;

    return {
      username: decoded.substring(0, colonIndex),
      password: decoded.substring(colonIndex + 1),
      proxyEndpoint: authData.proxyEndpoint,
    };
  } catch {
    return null;
  }
}

// ============================================================
// SHARED RESOURCE LOOKUP HELPERS
// ============================================================

/**
 * Find VPC by factiii:project tag
 */
export async function findVpc(projectName: string, region: string): Promise<string | null> {
  try {
    const ec2 = getEC2Client(region);
    const result = await ec2.send(new DescribeVpcsCommand({
      Filters: [projectFilter(projectName)],
    }));
    return result.Vpcs?.[0]?.VpcId ?? null;
  } catch {
    return null;
  }
}

/**
 * Find subnet by tag and type
 */
export async function findSubnet(projectName: string, region: string, type: string): Promise<string | null> {
  try {
    const ec2 = getEC2Client(region);
    const result = await ec2.send(new DescribeSubnetsCommand({
      Filters: [
        projectFilter(projectName),
        { Name: 'tag:factiii:subnet-type', Values: [type] },
      ],
    }));
    return result.Subnets?.[0]?.SubnetId ?? null;
  } catch {
    return null;
  }
}

/**
 * Find all private subnets
 */
export async function findPrivateSubnets(projectName: string, region: string): Promise<string[]> {
  try {
    const ec2 = getEC2Client(region);
    const result = await ec2.send(new DescribeSubnetsCommand({
      Filters: [
        projectFilter(projectName),
        { Name: 'tag:factiii:subnet-type', Values: ['private'] },
      ],
    }));
    return (result.Subnets ?? []).map(s => s.SubnetId!).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Find security group by name and VPC
 */
export async function findSecurityGroup(groupName: string, vpcId: string, region: string): Promise<string | null> {
  try {
    const ec2 = getEC2Client(region);
    const result = await ec2.send(new DescribeSecurityGroupsCommand({
      Filters: [
        { Name: 'group-name', Values: [groupName] },
        { Name: 'vpc-id', Values: [vpcId] },
      ],
    }));
    return result.SecurityGroups?.[0]?.GroupId ?? null;
  } catch {
    return null;
  }
}

/**
 * Find EC2 key pair by name
 */
export async function findKeyPair(keyName: string, region: string): Promise<boolean> {
  try {
    const ec2 = getEC2Client(region);
    const result = await ec2.send(new DescribeKeyPairsCommand({
      KeyNames: [keyName],
    }));
    return (result.KeyPairs?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Find running/stopped EC2 instance by tag
 */
export async function findInstance(projectName: string, region: string): Promise<string | null> {
  try {
    const ec2 = getEC2Client(region);
    const result = await ec2.send(new DescribeInstancesCommand({
      Filters: [
        projectFilter(projectName),
        { Name: 'instance-state-name', Values: ['running', 'stopped'] },
      ],
    }));
    return result.Reservations?.[0]?.Instances?.[0]?.InstanceId ?? null;
  } catch {
    return null;
  }
}

/**
 * Find Elastic IP associated with an instance
 */
export async function findElasticIp(instanceId: string, region: string): Promise<string | null> {
  try {
    const ec2 = getEC2Client(region);
    const result = await ec2.send(new DescribeAddressesCommand({
      Filters: [{ Name: 'instance-id', Values: [instanceId] }],
    }));
    return result.Addresses?.[0]?.PublicIp ?? null;
  } catch {
    return null;
  }
}

/**
 * Find internet gateway attached to VPC
 */
export async function findIgw(vpcId: string, region: string): Promise<string | null> {
  try {
    const ec2 = getEC2Client(region);
    const result = await ec2.send(new DescribeInternetGatewaysCommand({
      Filters: [{ Name: 'attachment.vpc-id', Values: [vpcId] }],
    }));
    return result.InternetGateways?.[0]?.InternetGatewayId ?? null;
  } catch {
    return null;
  }
}

/**
 * Find DB subnet group
 */
export async function findDbSubnetGroup(groupName: string, region: string): Promise<boolean> {
  try {
    const rds = getRDSClient(region);
    const result = await rds.send(new DescribeDBSubnetGroupsCommand({
      DBSubnetGroupName: groupName,
    }));
    return (result.DBSubnetGroups?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Find RDS instance by identifier
 */
export async function findRdsInstance(dbInstanceId: string, region: string): Promise<{ status: string; endpoint: string | null } | null> {
  try {
    const rds = getRDSClient(region);
    const result = await rds.send(new DescribeDBInstancesCommand({
      DBInstanceIdentifier: dbInstanceId,
    }));
    const instance = result.DBInstances?.[0];
    if (!instance) return null;
    return {
      status: instance.DBInstanceStatus ?? 'unknown',
      endpoint: instance.Endpoint?.Address ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Find RDS instance endpoint
 */
export async function findRdsEndpoint(projectName: string, region: string): Promise<string | null> {
  const dbId = 'factiii-' + projectName + '-db';
  const instance = await findRdsInstance(dbId, region);
  return instance?.endpoint ?? null;
}

/**
 * Check if ECR repository exists
 */
export async function findEcrRepo(repoName: string, region: string): Promise<boolean> {
  try {
    const ecr = getECRClient(region);
    await ecr.send(new DescribeRepositoriesCommand({
      repositoryNames: [repoName],
    }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if S3 bucket exists
 */
export async function findBucket(bucketName: string, region: string): Promise<boolean> {
  try {
    const s3 = getS3Client(region);
    await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if IAM user exists
 */
export async function findIamUser(userName: string, region: string): Promise<boolean> {
  try {
    const iam = getIAMClient(region);
    await iam.send(new GetUserCommand({ UserName: userName }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if domain is verified in SES
 */
export async function isDomainVerified(domain: string, region: string): Promise<boolean> {
  try {
    const ses = getSESClient(region);
    const result = await ses.send(new GetIdentityVerificationAttributesCommand({
      Identities: [domain],
    }));
    return result.VerificationAttributes?.[domain]?.VerificationStatus === 'Success';
  } catch {
    return false;
  }
}

/**
 * Check if DKIM is configured for domain
 */
export async function hasDkim(domain: string, region: string): Promise<boolean> {
  try {
    const ses = getSESClient(region);
    const result = await ses.send(new GetIdentityDkimAttributesCommand({
      Identities: [domain],
    }));
    return result.DkimAttributes?.[domain]?.DkimEnabled === true;
  } catch {
    return false;
  }
}

/**
 * Check if S3 bucket has CORS configured
 */
export async function hasCors(bucketName: string, region: string): Promise<boolean> {
  try {
    const s3 = getS3Client(region);
    const result = await s3.send(new GetBucketCorsCommand({ Bucket: bucketName }));
    return (result.CORSRules?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Check if AWS is configured for this project (shared guard)
 */
export function isAwsConfigured(config: FactiiiConfig): boolean {
  if (isOnServer()) return false;
  if (config.aws) return true;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { extractEnvironments } = require('../../../../utils/config-helpers.js');
  const environments = extractEnvironments(config);
  return Object.values(environments).some((e: unknown) => {
    const env = e as { pipeline?: string; access_key_id?: string; config?: string };
    return env.pipeline === 'aws' || !!env.access_key_id ||
      (!!env.config && ['ec2', 'free-tier', 'standard', 'enterprise'].includes(env.config));
  });
}

// ============================================================
// RE-EXPORTS for SDK commands used directly in scanfix files
// ============================================================

export {
  // EC2
  EC2Client,
  DescribeVpcsCommand,
  DescribeSubnetsCommand,
  DescribeSecurityGroupsCommand,
  DescribeInstancesCommand,
  DescribeKeyPairsCommand,
  DescribeAddressesCommand,
  DescribeInternetGatewaysCommand,
  DescribeAvailabilityZonesCommand,
  DescribeImagesCommand,
  CreateVpcCommand,
  ModifyVpcAttributeCommand,
  CreateSubnetCommand,
  ModifySubnetAttributeCommand,
  CreateInternetGatewayCommand,
  AttachInternetGatewayCommand,
  CreateRouteTableCommand,
  CreateRouteCommand,
  AssociateRouteTableCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  CreateKeyPairCommand,
  RunInstancesCommand,
  AllocateAddressCommand,
  AssociateAddressCommand,
  waitUntilInstanceRunning,
  // STS
  STSClient,
  GetCallerIdentityCommand,
  // IAM
  IAMClient,
  GetUserCommand,
  CreateUserCommand,
  PutUserPolicyCommand,
  CreateAccessKeyCommand,
  // RDS
  RDSClient,
  DescribeDBSubnetGroupsCommand,
  CreateDBSubnetGroupCommand,
  DescribeDBInstancesCommand,
  CreateDBInstanceCommand,
  // S3
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutPublicAccessBlockCommand,
  PutBucketEncryptionCommand,
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  // ECR
  ECRClient,
  DescribeRepositoriesCommand,
  CreateRepositoryCommand,
  PutLifecyclePolicyCommand,
  GetAuthorizationTokenCommand,
  // SES
  SESClient,
  VerifyDomainIdentityCommand,
  GetIdentityVerificationAttributesCommand,
  VerifyDomainDkimCommand,
  GetIdentityDkimAttributesCommand,
  GetSendQuotaCommand,
};
