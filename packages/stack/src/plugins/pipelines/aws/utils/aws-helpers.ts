/**
 * AWS Helper Utilities
 *
 * Shared functions for AWS SDK operations used across all AWS scanfix files.
 * Uses AWS SDK v3 clients instead of AWS CLI.
 */

// CRITICAL: lazy SDK loading.
// Why: the nine @aws-sdk/client-* packages cost ~100 ms to require, which was
// most of `npx stack` startup. Every AWS scanfix module imports this file, and
// factiii/index.ts imports those to build its `fixes` array, so a plain
// `import { EC2Client } from '@aws-sdk/client-ec2'` here loads the whole SDK on
// every command — including `--help`, `ops`, `db` and `backup`, which never
// touch AWS. The type imports below are erased by TypeScript and cost nothing;
// the `*Sdk()` accessors require the real package on first use and cache it.
// Breaks-if-changed: reintroducing a value import from '@aws-sdk/*' anywhere in
// this file, or in any scanfix file, puts the SDK back on the startup path.
import type * as Ec2 from '@aws-sdk/client-ec2';
import type * as Sts from '@aws-sdk/client-sts';
import type * as Iam from '@aws-sdk/client-iam';
import type * as Rds from '@aws-sdk/client-rds';
import type * as S3 from '@aws-sdk/client-s3';
import type * as Ecr from '@aws-sdk/client-ecr';
import type * as Ses from '@aws-sdk/client-ses';
import type * as Route53 from '@aws-sdk/client-route-53';
import type * as Ec2Ic from '@aws-sdk/client-ec2-instance-connect';

let _ec2Sdk: typeof Ec2 | undefined;
let _stsSdk: typeof Sts | undefined;
let _iamSdk: typeof Iam | undefined;
let _rdsSdk: typeof Rds | undefined;
let _s3Sdk: typeof S3 | undefined;
let _ecrSdk: typeof Ecr | undefined;
let _sesSdk: typeof Ses | undefined;
let _route53Sdk: typeof Route53 | undefined;
let _ec2IcSdk: typeof Ec2Ic | undefined;

/* eslint-disable @typescript-eslint/no-require-imports */
export function ec2Sdk(): typeof Ec2 {
  return (_ec2Sdk ??= require('@aws-sdk/client-ec2') as typeof Ec2);
}
export function stsSdk(): typeof Sts {
  return (_stsSdk ??= require('@aws-sdk/client-sts') as typeof Sts);
}
export function iamSdk(): typeof Iam {
  return (_iamSdk ??= require('@aws-sdk/client-iam') as typeof Iam);
}
export function rdsSdk(): typeof Rds {
  return (_rdsSdk ??= require('@aws-sdk/client-rds') as typeof Rds);
}
export function s3Sdk(): typeof S3 {
  return (_s3Sdk ??= require('@aws-sdk/client-s3') as typeof S3);
}
export function ecrSdk(): typeof Ecr {
  return (_ecrSdk ??= require('@aws-sdk/client-ecr') as typeof Ecr);
}
export function sesSdk(): typeof Ses {
  return (_sesSdk ??= require('@aws-sdk/client-ses') as typeof Ses);
}
export function route53Sdk(): typeof Route53 {
  return (_route53Sdk ??= require('@aws-sdk/client-route-53') as typeof Route53);
}
export function ec2IcSdk(): typeof Ec2Ic {
  return (_ec2IcSdk ??= require('@aws-sdk/client-ec2-instance-connect') as typeof Ec2Ic);
}
/* eslint-enable @typescript-eslint/no-require-imports */

import type { FactiiiConfig, EnvironmentConfig } from '../../../../types/index.js';
import { AnsibleVaultSecrets } from '../../../../utils/ansible-vault-secrets.js';

// Module-level flag: set to true when aws-credentials-sync fails.
// Other AWS fixes check this to skip their scans entirely.
let _credentialsSyncFailed = false;

/**
 * Mark credential sync as failed — all subsequent AWS fixes should skip.
 */
export function setCredentialsSyncFailed(): void {
  _credentialsSyncFailed = true;
}

/**
 * Check if credential sync failed — if so, other AWS fixes should not run.
 */
export function didCredentialsSyncFail(): boolean {
  return _credentialsSyncFailed;
}

// ============================================================
// IN-MEMORY CREDENTIAL CACHE
// ============================================================
// Stack never reads or writes ~/.aws/credentials. All AWS SDK clients
// receive explicit `credentials` constructed from this cache, which is
// populated once per process by loadAwsCredentials().

interface LoadedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

let _loadedCreds: LoadedCredentials | null = null;

export function getLoadedCredentials(): LoadedCredentials {
  if (!_loadedCreds) {
    throw new Error(
      'AWS credentials not loaded. Call loadAwsCredentials(config, rootDir) first.'
    );
  }
  return _loadedCreds;
}

export function setLoadedCredentials(creds: LoadedCredentials): void {
  _loadedCreds = creds;
  clearClientCache();
}

export function clearLoadedCredentials(): void {
  _loadedCreds = null;
  clearClientCache();
}

export async function verifyCredentialsWithSts(
  accessKeyId: string,
  secretAccessKey: string,
  region: string
): Promise<string | null> {
  try {
    const sts = new (stsSdk().STSClient)({
      region,
      credentials: { accessKeyId, secretAccessKey },
    });
    const result = await sts.send(new (stsSdk().GetCallerIdentityCommand)({}));
    return result.Account ?? null;
  } catch {
    return null;
  }
}

/**
 * Load AWS credentials from this repo's vault into the in-memory cache.
 *
 * - Idempotent: returns early if already loaded.
 * - Throws when ansible vault is not configured.
 * - Throws when vault has no AWS credentials (caller should run bootstrap fix).
 * - Does NOT prompt the user — pure read. Mismatch resolution lives in the
 *   aws-credentials-sync scanfix.
 */
export async function loadAwsCredentials(
  config: FactiiiConfig,
  rootDir: string
): Promise<void> {
  if (_loadedCreds) return;

  if (!config.ansible?.vault_path) {
    throw new Error(
      'AWS credentials cannot be loaded: ansible.vault_path is not configured in stack.yml. Run `npx stack init` first.'
    );
  }

  const awsConfig = getAwsConfig(config);
  const region = awsConfig.region || 'us-east-1';

  const vault = new AnsibleVaultSecrets({
    vault_path: config.ansible.vault_path,
    vault_password_file: config.ansible.vault_password_file,
    rootDir,
  });

  const accessKeyId = await vault.getSecret('AWS_ACCESS_KEY_ID');
  const secretAccessKey = await vault.getSecret('AWS_SECRET_ACCESS_KEY');

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'AWS credentials not found in vault. Run `npx stack fix --dev` to bootstrap.'
    );
  }

  setLoadedCredentials({ accessKeyId, secretAccessKey, region });
}

// ============================================================
// CLIENT FACTORIES — cached per region
// ============================================================

const clientCache: Record<string, unknown> = {};

/**
 * Clear all cached AWS SDK clients.
 * Call after swapping credentials (e.g. writing new ~/.aws/credentials)
 * so new clients pick up the updated credentials.
 */
export function clearClientCache(): void {
  for (const key of Object.keys(clientCache)) {
    delete clientCache[key];
  }
}

function getCachedClient<T>(
  ClientClass: new (config: {
    region: string;
    credentials?: { accessKeyId: string; secretAccessKey: string };
  }) => T,
  region: string
): T {
  const creds = getLoadedCredentials();
  const key = ClientClass.name + ':' + region + ':' + creds.accessKeyId;
  if (!clientCache[key]) {
    clientCache[key] = new ClientClass({
      region,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
      },
    });
  }
  return clientCache[key] as T;
}

export function getEC2Client(region: string): Ec2.EC2Client {
  return getCachedClient(ec2Sdk().EC2Client, region);
}

export function getSTSClient(region: string): Sts.STSClient {
  return getCachedClient(stsSdk().STSClient, region);
}

export function getIAMClient(region: string): Iam.IAMClient {
  return getCachedClient(iamSdk().IAMClient, region);
}

export function getRDSClient(region: string): Rds.RDSClient {
  return getCachedClient(rdsSdk().RDSClient, region);
}

export function getS3Client(region: string): S3.S3Client {
  return getCachedClient(s3Sdk().S3Client, region);
}

export function getECRClient(region: string): Ecr.ECRClient {
  return getCachedClient(ecrSdk().ECRClient, region);
}

export function getSESClient(region: string): Ses.SESClient {
  return getCachedClient(sesSdk().SESClient, region);
}

export function getRoute53Client(region: string): Route53.Route53Client {
  return getCachedClient(route53Sdk().Route53Client, region);
}

export function getEC2ICClient(region: string): Ec2Ic.EC2InstanceConnectClient {
  return getCachedClient(ec2IcSdk().EC2InstanceConnectClient, region);
}

// ============================================================
// TAGGING HELPERS
// ============================================================

/**
 * Build standard tags array for AWS resources
 */
export function buildTags(projectName: string, extraTags?: Record<string, string>): Ec2.Tag[] {
  const tags: Ec2.Tag[] = [
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
export function tagSpec(resourceType: string, projectName: string, extraTags?: Record<string, string>): Ec2.TagSpecification {
  return {
    ResourceType: resourceType as Ec2.TagSpecification['ResourceType'],
    Tags: buildTags(projectName, extraTags),
  };
}

/**
 * Build a filter for factiii:project tag
 */
export function projectFilter(projectName: string): Ec2.Filter {
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
  // Start with top-level aws block values (if any)
  let region = config.aws?.region ?? '';
  let configType = config.aws?.config ?? '';
  let accessKeyId = config.aws?.access_key_id;

  // Always check environments for access_key_id (may be under prod/staging, not aws block)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { extractEnvironments } = require('../../../../utils/config-helpers.js');
  const environments = extractEnvironments(config) as Record<string, EnvironmentConfig>;
  for (const env of Object.values(environments)) {
    if (env.pipeline === 'aws' || env.access_key_id || env.config) {
      if (!accessKeyId && env.access_key_id) accessKeyId = env.access_key_id;
      if (!region && env.region) region = env.region;
      if (!configType && env.config) configType = env.config;
      break;
    }
  }

  return {
    region: region || 'us-east-1',
    configType: configType || 'ec2',
    accessKeyId,
  };
}

/**
 * Check if running on server (skip AWS provisioning)
 */
export function isOnServer(): boolean {
  return process.env.FACTIII_ON_SERVER === 'true' || process.env.GITHUB_ACTIONS === 'true';
}

/**
 * Confirm before running an AWS-mutating action (create/modify resource).
 *
 * Auto-approves and returns true in any of these contexts (where prompting
 * is impossible or undesirable):
 *   - STACK_AWS_AUTO_APPROVE=1
 *   - GITHUB_ACTIONS=true / FACTIII_ON_SERVER=true
 *   - non-interactive (no TTY)
 *
 * Otherwise prints the description block and prompts y/N. Default is N to
 * stop accidental provisioning during fix runs.
 *
 * Description format suggestion (multi-line is OK):
 *   "Create S3 bucket 'factiii-prod' (us-east-1, encrypted, public access blocked)"
 */
export async function confirmAwsAction(description: string): Promise<boolean> {
  if (process.env.STACK_AWS_AUTO_APPROVE === '1') return true;
  if (isOnServer()) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return true;

  console.log('');
  console.log('   ┌─ AWS action ────────────────────────────────────────────');
  for (const line of description.split('\n')) {
    console.log('   │ ' + line);
  }
  console.log('   └─────────────────────────────────────────────────────────');
  const { confirm } = await import('../../../../utils/secret-prompts.js');
  return confirm('   Proceed?', false);
}

/**
 * Get project name for tagging
 */
export function getProjectName(config: FactiiiConfig): string {
  return config.name ?? 'app';
}

/**
 * Resource name overrides — let users adopt pre-existing AWS resources whose
 * names don't follow stack's `factiii-{project}-X` convention, without having
 * to rename them in AWS.
 *
 * Sources, by precedence (override wins):
 *   - `config.aws.<field>`
 *   - top-level `config.<field>` (legacy spot: ecr_repository)
 *   - convention default
 */
export interface ResourceNames {
  /** null means "use the auto-resolve flow" (try simple name, then accountId-scoped). */
  s3Bucket: string | null;
  rdsInstanceId: string;
  ecrRepository: string;
  ec2SecurityGroup: string;
  rdsSecurityGroup: string;
}

export function getResourceNames(config: FactiiiConfig): ResourceNames {
  const project = getProjectName(config);
  const aws = config.aws ?? {};
  return {
    s3Bucket: aws.s3_bucket ?? null,
    rdsInstanceId: aws.rds_instance_id ?? ('factiii-' + project + '-db'),
    ecrRepository: aws.ecr_repository ?? config.ecr_repository ?? project,
    ec2SecurityGroup: aws.ec2_security_group ?? ('factiii-' + project + '-ec2'),
    rdsSecurityGroup: aws.rds_security_group ?? ('factiii-' + project + '-rds'),
  };
}

/**
 * Get AWS account ID via STS
 */
export async function getAwsAccountId(region: string): Promise<string | null> {
  try {
    const sts = getSTSClient(region);
    const result = await sts.send(new (stsSdk().GetCallerIdentityCommand)({}));
    return result.Account ?? null;
  } catch {
    return null;
  }
}

/**
 * Get a human-readable identity string for the current AWS caller.
 * Shows access_key_id + user name instead of ARN, since ARNs are
 * unreadable without looking them up in the AWS console.
 */
export async function getCallerArn(region: string): Promise<string | null> {
  try {
    const sts = getSTSClient(region);
    const result = await sts.send(new (stsSdk().GetCallerIdentityCommand)({}));
    const arn = result.Arn ?? '';
    const userName = arn.includes('/') ? arn.split('/').pop() : null;
    let accessKeyId: string | null = null;
    try {
      accessKeyId = getLoadedCredentials().accessKeyId;
    } catch { /* not loaded */ }
    if (userName && accessKeyId) return userName + ' (' + accessKeyId + ')';
    if (userName) return userName;
    if (accessKeyId) return accessKeyId;
    return arn || null;
  } catch {
    return null;
  }
}

/**
 * Check if current AWS credentials have IAM management permissions
 */
export async function canManageIam(region: string): Promise<boolean> {
  try {
    const iam = getIAMClient(region);
    await iam.send(new (iamSdk().ListUsersCommand)({ MaxItems: 1 }));
    return true;
  } catch {
    return false;
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
    const result = await ecr.send(new (ecrSdk().GetAuthorizationTokenCommand)({}));
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
 * Find VPC by factiii:project tag, or return `aws.vpc_id` override.
 */
export async function findVpc(projectName: string, region: string, config?: FactiiiConfig): Promise<string | null> {
  if (config?.aws?.vpc_id) return config.aws.vpc_id;
  try {
    const ec2 = getEC2Client(region);
    const result = await ec2.send(new (ec2Sdk().DescribeVpcsCommand)({
      Filters: [projectFilter(projectName)],
    }));
    return result.Vpcs?.[0]?.VpcId ?? null;
  } catch {
    return null;
  }
}

/**
 * Find subnet by tag and type, or return the corresponding override
 * (`aws.subnet_public_id` for type=public).
 */
export async function findSubnet(projectName: string, region: string, type: string, config?: FactiiiConfig): Promise<string | null> {
  if (type === 'public' && config?.aws?.subnet_public_id) return config.aws.subnet_public_id;
  try {
    const ec2 = getEC2Client(region);
    const result = await ec2.send(new (ec2Sdk().DescribeSubnetsCommand)({
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
 * Find private subnets by tag, or return `aws.subnet_private_ids` override.
 */
export async function findPrivateSubnets(projectName: string, region: string, config?: FactiiiConfig): Promise<string[]> {
  if (config?.aws?.subnet_private_ids?.length) return config.aws.subnet_private_ids;
  try {
    const ec2 = getEC2Client(region);
    const result = await ec2.send(new (ec2Sdk().DescribeSubnetsCommand)({
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
    const result = await ec2.send(new (ec2Sdk().DescribeSecurityGroupsCommand)({
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
    const result = await ec2.send(new (ec2Sdk().DescribeKeyPairsCommand)({
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
    const result = await ec2.send(new (ec2Sdk().DescribeInstancesCommand)({
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
 * Get the public IP of the running EC2 instance for a project.
 * Falls back to Elastic IP if available. Used as DNS fallback when domain hasn't propagated.
 */
export async function findInstancePublicIp(projectName: string, region: string): Promise<string | null> {
  try {
    const ec2 = getEC2Client(region);
    const result = await ec2.send(new (ec2Sdk().DescribeInstancesCommand)({
      Filters: [
        projectFilter(projectName),
        { Name: 'instance-state-name', Values: ['running'] },
      ],
    }));
    const instance = result.Reservations?.[0]?.Instances?.[0];
    if (!instance) return null;
    // Prefer Elastic IP (stable), fall back to public IP (changes on restart)
    const instanceId = instance.InstanceId;
    if (instanceId) {
      const elasticIp = await findElasticIp(instanceId, region);
      if (elasticIp) return elasticIp;
    }
    return instance.PublicIpAddress ?? null;
  } catch {
    return null;
  }
}

/**
 * Push a temporary SSH public key to an EC2 instance via EC2 Instance Connect.
 * The key is valid for 60 seconds — SSH must connect within that window.
 * Requires ec2-instance-connect agent on the instance (pre-installed on Ubuntu 22.04+).
 *
 * @returns true if the key was pushed successfully
 */
export async function pushSshPublicKey(
  instanceId: string,
  osUser: string,
  sshPublicKey: string,
  region: string,
  availabilityZone?: string
): Promise<boolean> {
  try {
    // Get the instance's availability zone if not provided
    let az = availabilityZone;
    if (!az) {
      const ec2 = getEC2Client(region);
      const desc = await ec2.send(new (ec2Sdk().DescribeInstancesCommand)({
        InstanceIds: [instanceId],
      }));
      az = desc.Reservations?.[0]?.Instances?.[0]?.Placement?.AvailabilityZone;
    }
    if (!az) return false;

    const ic = getEC2ICClient(region);
    const result = await ic.send(new (ec2IcSdk().SendSSHPublicKeyCommand)({
      InstanceId: instanceId,
      InstanceOSUser: osUser,
      SSHPublicKey: sshPublicKey,
      AvailabilityZone: az,
    }));
    return result.Success === true;
  } catch {
    return false;
  }
}

/**
 * Find Elastic IP associated with an instance
 */
export async function findElasticIp(instanceId: string, region: string): Promise<string | null> {
  try {
    const ec2 = getEC2Client(region);
    const result = await ec2.send(new (ec2Sdk().DescribeAddressesCommand)({
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
    const result = await ec2.send(new (ec2Sdk().DescribeInternetGatewaysCommand)({
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
    const result = await rds.send(new (rdsSdk().DescribeDBSubnetGroupsCommand)({
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
    const result = await rds.send(new (rdsSdk().DescribeDBInstancesCommand)({
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
    await ecr.send(new (ecrSdk().DescribeRepositoriesCommand)({
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
    await s3.send(new (s3Sdk().HeadBucketCommand)({ Bucket: bucketName }));
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
    await iam.send(new (iamSdk().GetUserCommand)({ UserName: userName }));
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
    const result = await ses.send(new (sesSdk().GetIdentityVerificationAttributesCommand)({
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
    const result = await ses.send(new (sesSdk().GetIdentityDkimAttributesCommand)({
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
    const result = await s3.send(new (s3Sdk().GetBucketCorsCommand)({ Bucket: bucketName }));
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

/**
 * Find Route53 hosted zone for a domain
 * Returns the hosted zone ID if found, null otherwise
 */
export async function findHostedZone(domain: string, region: string): Promise<string | null> {
  try {
    const r53 = getRoute53Client(region);
    // Ensure domain has trailing dot for Route53 lookup
    const dnsName = domain.endsWith('.') ? domain : domain + '.';
    const result = await r53.send(new (route53Sdk().ListHostedZonesByNameCommand)({
      DNSName: dnsName,
      MaxItems: 1,
    }));
    const zone = result.HostedZones?.[0];
    if (zone && zone.Name === dnsName) {
      // Extract zone ID (remove /hostedzone/ prefix)
      return zone.Id?.replace('/hostedzone/', '') ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Find an A record in a hosted zone
 */
export async function findARecord(domain: string, hostedZoneId: string, region: string): Promise<string | null> {
  try {
    const r53 = getRoute53Client(region);
    const dnsName = domain.endsWith('.') ? domain : domain + '.';
    const result = await r53.send(new (route53Sdk().ListResourceRecordSetsCommand)({
      HostedZoneId: hostedZoneId,
      StartRecordName: dnsName,
      StartRecordType: 'A',
      MaxItems: 1,
    }));
    const record = result.ResourceRecordSets?.[0];
    if (record && record.Name === dnsName && record.Type === 'A') {
      return record.ResourceRecords?.[0]?.Value ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================
// SDK ACCESS for scanfix files
// ============================================================
// Scanfix files no longer import command classes from here. They call the
// `*Sdk()` accessors above inside their scan/fix bodies, which keeps the SDK
// off the module-load path. See the CRITICAL note at the top of this file.
