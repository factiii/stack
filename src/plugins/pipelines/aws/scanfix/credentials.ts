/**
 * AWS Credential Fixes
 *
 * Handles AWS account setup guidance, credential validation,
 * and region configuration checks.
 */

import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { isAwsCliInstalled, getAwsAccountId, getAwsConfig } from '../utils/aws-helpers.js';

export const credentialsFixes: Fix[] = [
  // ============================================================
  // DEV STAGE - AWS CLI and account setup
  // ============================================================
  {
    id: 'aws-account-not-setup',
    stage: 'dev',
    severity: 'critical',
    description: 'AWS CLI not installed or not configured',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // Only check if AWS pipeline is configured
      const awsConfig = getAwsConfig(config);
      if (!awsConfig.accessKeyId && !config.aws) return false;

      // Check if AWS CLI is installed
      if (!isAwsCliInstalled()) return true;

      // Check if credentials are configured (can call STS)
      const accountId = getAwsAccountId(awsConfig.region);
      return !accountId;
    },
    fix: null,
    manualFix: [
      'Setup AWS CLI:',
      '',
      '1. Create an AWS account at https://aws.amazon.com (free tier available)',
      '',
      '2. Install AWS CLI:',
      '   Windows: winget install Amazon.AWSCLI',
      '   macOS:   brew install awscli',
      '   Linux:   curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" && unzip awscliv2.zip && sudo ./aws/install',
      '',
      '3. Create an IAM user in AWS Console:',
      '   IAM → Users → Create user → Attach AdministratorAccess policy',
      '   → Security credentials → Create access key',
      '',
      '4. Configure AWS CLI:',
      '   aws configure',
      '   (Enter Access Key ID, Secret Access Key, region)',
    ].join('\n'),
  },
  {
    id: 'aws-region-configured',
    stage: 'dev',
    severity: 'warning',
    description: 'AWS region not configured in factiii.yml',
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
    manualFix: 'Set aws.region in factiii.yml under the prod environment or top-level aws block',
  },

  // ============================================================
  // SECRETS STAGE - Credential validation
  // ============================================================
  {
    id: 'aws-credentials-missing',
    stage: 'secrets',
    severity: 'critical',
    description: 'AWS credentials not available (env vars or Ansible Vault)',
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
      '    npx factiii secrets edit',
    ].join('\n'),
  },
  {
    id: 'aws-credentials-invalid',
    stage: 'secrets',
    severity: 'warning',
    description: 'AWS credentials are invalid or expired',
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
          const { execSync } = await import('child_process');
          const result = execSync('aws configure get aws_access_key_id 2>/dev/null || echo ""', {
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
    manualFix: 'Check AWS credentials: aws sts get-caller-identity\nIf expired, regenerate in AWS Console: IAM → Users → Security credentials',
  },
];
