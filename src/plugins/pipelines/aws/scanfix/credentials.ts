/**
 * AWS Credential Fixes
 *
 * Handles AWS account setup, credential validation,
 * and region configuration checks.
 *
 * The aws-account-not-setup fix auto-bootstraps:
 * 1. Checks if AWS CLI has valid credentials
 * 2. If not, prompts user to login via `aws configure` (root or admin)
 * 3. Confirms with user before creating IAM admin user
 * 4. Creates IAM user, attaches bootstrap policy, creates access key
 * 5. Auto-configures AWS CLI with new IAM credentials
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { isAwsCliInstalled, getAwsAccountId, getAwsConfig, awsExec, awsExecSafe } from '../utils/aws-helpers.js';

/**
 * Check if IAM user exists
 */
function findIamUser(userName: string, region: string): boolean {
  const result = awsExecSafe(
    'aws iam get-user --user-name ' + userName,
    region
  );
  return !!result && !result.includes('NoSuchEntity');
}

/**
 * Read the bootstrap policy JSON from the policies directory
 */
function getBootstrapPolicy(): string {
  // Try dist path first (published package), then src path (development)
  const distPath = path.resolve(__dirname, '..', 'policies', 'bootstrap-policy.json');
  const srcPath = path.resolve(__dirname, '..', '..', '..', '..', '..', 'src', 'plugins', 'pipelines', 'aws', 'policies', 'bootstrap-policy.json');

  if (fs.existsSync(distPath)) {
    return fs.readFileSync(distPath, 'utf8').trim();
  }
  if (fs.existsSync(srcPath)) {
    return fs.readFileSync(srcPath, 'utf8').trim();
  }

  throw new Error('bootstrap-policy.json not found');
}

/**
 * Auto-bootstrap AWS account:
 * Phase A: Check existing credentials
 * Phase B: Interactive root/admin login
 * Phase C: Confirm and create IAM admin user
 * Phase D: Auto-configure with new IAM credentials
 */
async function bootstrapAwsAccount(config: FactiiiConfig): Promise<boolean> {
  const awsConfig = getAwsConfig(config);
  const region = awsConfig.region || 'us-east-1';

  // ============================================================
  // Phase A: Check if AWS CLI already has valid credentials
  // ============================================================
  let accountId = getAwsAccountId(region);
  if (accountId) {
    console.log('   AWS credentials already configured (account: ' + accountId + ')');
    return true;
  }

  // ============================================================
  // Phase B: Prompt root/admin user to login via aws configure
  // ============================================================
  console.log('');
  console.log('   ============================================================');
  console.log('   AWS CLI has no valid credentials configured.');
  console.log('   Login with your AWS root account or an IAM admin user.');
  console.log('   ============================================================');
  console.log('');
  console.log('   Running: aws configure');
  console.log('   (Enter your Access Key ID, Secret Access Key, and region)');
  console.log('');

  try {
    execSync('aws configure', { stdio: 'inherit' });
  } catch (e) {
    console.log('   aws configure failed: ' + (e instanceof Error ? e.message : String(e)));
    return false;
  }

  // Verify credentials work after aws configure
  accountId = getAwsAccountId(region);
  if (!accountId) {
    console.log('   AWS credentials still invalid after configuration.');
    console.log('   Please verify your Access Key ID and Secret Access Key.');
    return false;
  }

  console.log('   [OK] AWS login successful (account: ' + accountId + ')');

  // ============================================================
  // Phase C: Confirm and create IAM admin user
  // ============================================================
  const userName = 'factiii-admin';

  // Check if user already exists
  if (findIamUser(userName, region)) {
    console.log('   [OK] IAM user ' + userName + ' already exists');
    return true;
  }

  console.log('');
  console.log('   ============================================================');
  console.log('   CREATE IAM ADMIN USER');
  console.log('   ============================================================');
  console.log('   Will create IAM user "' + userName + '" with bootstrap policy');
  console.log('   (EC2, RDS, S3, ECR, SES, IAM, STS permissions)');
  console.log('');
  console.log('   This replaces root credentials with a scoped IAM user.');
  console.log('   ============================================================');
  console.log('');

  // Import confirm from secret-prompts
  const { confirm } = await import('../../../../utils/secret-prompts.js');
  const proceed = await confirm('   Create IAM user "' + userName + '"?', true);

  if (!proceed) {
    console.log('   [--] Skipped IAM user creation');
    console.log('   You can create it manually later or re-run: npx stack fix');
    return true; // Credentials are valid, just no IAM user
  }

  try {
    // Create IAM user
    awsExec('aws iam create-user --user-name ' + userName, region);
    console.log('   [OK] Created IAM user: ' + userName);

    // Read and attach bootstrap policy
    const policy = getBootstrapPolicy();
    awsExec(
      'aws iam put-user-policy --user-name ' + userName +
      ' --policy-name factiii-bootstrap' +
      " --policy-document '" + policy + "'",
      region
    );
    console.log('   [OK] Attached bootstrap policy (EC2, RDS, S3, ECR, SES, IAM, STS)');

    // Create access key
    const keyResult = awsExec(
      'aws iam create-access-key --user-name ' + userName,
      region
    );
    const parsed = JSON.parse(keyResult);
    const newAccessKeyId = parsed.AccessKey?.AccessKeyId;
    const newSecretKey = parsed.AccessKey?.SecretAccessKey;

    if (!newAccessKeyId || !newSecretKey) {
      console.log('   [!] Failed to parse access key from AWS response');
      return false;
    }

    console.log('   [OK] Created access key for ' + userName);

    // ============================================================
    // Phase D: Auto-configure AWS CLI with new IAM credentials
    // ============================================================
    execSync('aws configure set aws_access_key_id ' + newAccessKeyId, { stdio: 'pipe' });
    execSync('aws configure set aws_secret_access_key ' + newSecretKey, { stdio: 'pipe' });
    execSync('aws configure set region ' + region, { stdio: 'pipe' });

    // Verify new credentials work
    const verifyId = getAwsAccountId(region);
    if (!verifyId) {
      console.log('   [!] New IAM credentials failed verification');
      return false;
    }

    console.log('   [OK] AWS CLI configured with IAM user ' + userName + ' (root credentials replaced)');
    console.log('');
    console.log('   Access Key ID:     ' + newAccessKeyId);
    console.log('   Account:           ' + verifyId);
    console.log('   Region:            ' + region);
    console.log('');
    console.log('   TIP: Store the secret key in Ansible Vault: npx stack secrets set AWS_SECRET_ACCESS_KEY');

    return true;
  } catch (e) {
    console.log('   [!] Failed to create IAM user: ' + (e instanceof Error ? e.message : String(e)));
    console.log('   You may need to create the IAM user manually in the AWS Console.');
    return false;
  }
}

export const credentialsFixes: Fix[] = [
  // ============================================================
  // DEV STAGE - AWS CLI and account setup
  // ============================================================
  {
    id: 'aws-account-not-setup',
    stage: 'dev',
    severity: 'critical',
    description: '☁️ AWS CLI not installed or not configured',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // Only check if AWS pipeline is configured
      const awsConfig = getAwsConfig(config);
      if (!awsConfig.accessKeyId && !config.aws) {
        // Also check per-environment pipeline: aws
        const { extractEnvironments } = await import('../../../../utils/config-helpers.js');
        const environments = extractEnvironments(config);
        const hasAwsEnv = Object.values(environments).some(
          (e: { pipeline?: string }) => e.pipeline === 'aws'
        );
        if (!hasAwsEnv) return false;
      }

      // Check if AWS CLI is installed
      if (!isAwsCliInstalled()) return true;

      // Check if credentials are configured (can call STS)
      const accountId = getAwsAccountId(awsConfig.region);
      return !accountId;
    },
    fix: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      return bootstrapAwsAccount(config);
    },
    manualFix: [
      '============================================================',
      'AWS SETUP',
      '============================================================',
      '',
      '  1. Install AWS CLI:    brew install awscli  (or winget install Amazon.AWSCLI)',
      '  2. Configure CLI:      aws configure  (paste access key ID + secret)',
      '  3. Run:                npx stack fix  (auto-creates IAM admin user)',
      '',
      '  Or manually:',
      '  2. Create IAM user:    AWS Console > IAM > Users > Create "factiii-admin"',
      '  3. Attach policy:      policies/bootstrap-policy.json',
      '  4. Create access key:  User > Security credentials > Create access key > CLI',
      '  5. Configure CLI:      aws configure',
      '',
      '============================================================',
    ].join('\n'),
  },
  {
    id: 'aws-region-configured',
    stage: 'dev',
    severity: 'warning',
    description: '🌍 AWS region not configured in stack.yml',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // Only check if AWS pipeline is configured
      const { extractEnvironments } = await import('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);
      const hasAwsEnv = Object.values(environments).some(
        (e: { pipeline?: string }) => e.pipeline === 'aws'
      );
      if (!hasAwsEnv && !config.aws) return false;

      const awsConfig = getAwsConfig(config);
      // Check if region is explicitly set (not just default)
      return !awsConfig.region || awsConfig.region === 'us-east-1' && !config.aws?.region;
    },
    fix: null,
    manualFix: 'Set aws.region in stack.yml under the prod environment or top-level aws block',
  },

  // ============================================================
  // SECRETS STAGE - Credential validation
  // ============================================================
  {
    id: 'aws-credentials-missing',
    stage: 'secrets',
    severity: 'critical',
    description: '🔑 AWS credentials not available (env vars or Ansible Vault)',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // Only check if AWS pipeline is configured
      const { extractEnvironments } = await import('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);
      const hasAwsEnv = Object.values(environments).some(
        (e: { pipeline?: string }) => e.pipeline === 'aws'
      );
      if (!hasAwsEnv && !config.aws) return false;

      // Check env vars
      if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
        return false;
      }

      // Check if Ansible Vault has AWS credentials
      if (config.ansible?.vault_path) {
        try {
          const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
          const vault = new AnsibleVaultSecrets({
            vault_path: config.ansible.vault_path,
            vault_password_file: config.ansible.vault_password_file,
          });
          const result = await vault.checkSecrets(['aws_access_key_id', 'aws_secret_access_key']);
          if (result.status?.aws_access_key_id && result.status?.aws_secret_access_key) {
            return false;
          }
        } catch {
          // Vault not accessible
        }
      }

      return true;
    },
    fix: null,
    manualFix: [
      'Configure AWS credentials via one of:',
      '',
      '  Option A: Environment variables',
      '    export AWS_ACCESS_KEY_ID=AKIA...',
      '    export AWS_SECRET_ACCESS_KEY=...',
      '',
      '  Option B: AWS CLI configuration',
      '    aws configure',
      '',
      '  Option C: Ansible Vault (recommended)',
      '    Add aws_access_key_id and aws_secret_access_key to your vault file',
      '    npx stack secrets edit',
    ].join('\n'),
  },
  {
    id: 'aws-credentials-invalid',
    stage: 'secrets',
    severity: 'warning',
    description: '🔑 AWS credentials are invalid or expired',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // Only check if AWS CLI is installed and credentials exist
      if (!isAwsCliInstalled()) return false;
      if (!process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_SECRET_ACCESS_KEY) {
        // No env vars - might be using aws configure or vault
        // Try to validate anyway
      }

      const awsConfig = getAwsConfig(config);
      const accountId = getAwsAccountId(awsConfig.region);
      // If we can't get account ID, credentials are invalid
      // But only flag if we actually have credentials configured
      if (!accountId) {
        // Check if aws configure has credentials
        try {
          const result = execSync('aws configure get aws_access_key_id 2>nul || echo ""', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
          // Only flag as invalid if credentials exist but don't work
          return result.length > 0;
        } catch {
          return false;
        }
      }
      return false;
    },
    fix: null,
    manualFix: 'Check AWS credentials: aws sts get-caller-identity\nIf expired, regenerate in AWS Console: IAM > Users > Security credentials',
  },
];
