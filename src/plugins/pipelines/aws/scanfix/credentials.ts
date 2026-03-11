/**
 * AWS Credential Fixes
 *
 * Handles AWS account setup, credential validation,
 * and region configuration checks.
 *
 * The aws-account-not-setup fix auto-bootstraps:
 * 1. Checks if AWS SDK can get caller identity (valid credentials)
 * 2. If not, prompts user to login via `aws configure` (root or admin)
 * 3. Confirms with user before creating IAM admin user
 * 4. Creates IAM user, attaches bootstrap policy, creates access key
 * 5. Auto-configures AWS CLI with new IAM credentials
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import {
  getAwsAccountId,
  getAwsConfig,
  getIAMClient,
  findIamUser,
  CreateUserCommand,
  PutUserPolicyCommand,
  CreateAccessKeyCommand,
  writeAwsCredentials,
  readAwsRegionFromConfig,
} from '../utils/aws-helpers.js';

/**
 * Read the bootstrap policy JSON from the policies directory
 */
function getBootstrapPolicy(): string {
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
 * Auto-bootstrap AWS account using SDK + CLI for credential setup
 */
async function bootstrapAwsAccount(config: FactiiiConfig): Promise<boolean> {
  const awsConfig = getAwsConfig(config);
  const region = awsConfig.region || 'us-east-1';

  // Phase A: Check if credentials already work
  let accountId = await getAwsAccountId(region);
  if (accountId) {
    console.log('   AWS credentials already configured (account: ' + accountId + ')');
    return true;
  }

  // Phase B: Prompt user for AWS credentials directly (no CLI needed)
  console.log('');
  console.log('   ============================================================');
  console.log('   AWS credentials not configured.');
  console.log('   Login with your AWS root account or an IAM admin user.');
  console.log('   ============================================================');
  console.log('');

  const { promptSingleLine } = await import('../../../../utils/secret-prompts.js');
  const inputAccessKeyId = await promptSingleLine('   AWS Access Key ID: ');
  const inputSecretKey = await promptSingleLine('   AWS Secret Access Key: ', { hidden: true });
  const inputRegion = await promptSingleLine('   Default region [' + region + ']: ');
  const finalRegion = inputRegion || region;

  if (!inputAccessKeyId || !inputSecretKey) {
    console.log('   Access Key ID and Secret Access Key are required.');
    return false;
  }

  writeAwsCredentials(inputAccessKeyId, inputSecretKey, finalRegion);

  accountId = await getAwsAccountId(region);
  if (!accountId) {
    console.log('   AWS credentials still invalid after configuration.');
    console.log('   Please verify your Access Key ID and Secret Access Key.');
    return false;
  }

  console.log('   [OK] AWS login successful (account: ' + accountId + ')');

  // Phase C: Create IAM admin user
  const userName = 'factiii-admin';

  if (await findIamUser(userName, region)) {
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

  const { confirm } = await import('../../../../utils/secret-prompts.js');
  const proceed = await confirm('   Create IAM user "' + userName + '"?', true);

  if (!proceed) {
    console.log('   [--] Skipped IAM user creation');
    console.log('   You can create it manually later or re-run: npx stack fix');
    return true;
  }

  try {
    const iam = getIAMClient(region);

    // Create IAM user
    await iam.send(new CreateUserCommand({ UserName: userName }));
    console.log('   [OK] Created IAM user: ' + userName);

    // Read and attach bootstrap policy
    const policy = getBootstrapPolicy();
    await iam.send(new PutUserPolicyCommand({
      UserName: userName,
      PolicyName: 'factiii-bootstrap',
      PolicyDocument: policy,
    }));
    console.log('   [OK] Attached bootstrap policy (EC2, RDS, S3, ECR, SES, IAM, STS)');

    // Create access key
    const keyResult = await iam.send(new CreateAccessKeyCommand({ UserName: userName }));
    const newAccessKeyId = keyResult.AccessKey?.AccessKeyId;
    const newSecretKey = keyResult.AccessKey?.SecretAccessKey;

    if (!newAccessKeyId || !newSecretKey) {
      console.log('   [!] Failed to parse access key from AWS response');
      return false;
    }

    console.log('   [OK] Created access key for ' + userName);

    // Phase D: Write new IAM credentials to ~/.aws/
    writeAwsCredentials(newAccessKeyId, newSecretKey, region);

    // Verify new credentials work
    const verifyId = await getAwsAccountId(region);
    if (!verifyId) {
      console.log('   [!] New IAM credentials failed verification');
      return false;
    }

    console.log('   [OK] AWS CLI configured with IAM user ' + userName + ' (root credentials replaced)');
    console.log('');
    console.log('   Access Key ID:     ' + newAccessKeyId);
    console.log('   Account:           ' + verifyId);
    console.log('   Region:            ' + region);

    // Auto-store in Ansible Vault if configured
    if (config.ansible?.vault_path) {
      try {
        const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
        const vault = new AnsibleVaultSecrets({
          vault_path: config.ansible.vault_path,
          vault_password_file: config.ansible.vault_password_file,
        });
        const keyResult2 = await vault.setSecret('AWS_SECRET_ACCESS_KEY', newSecretKey);
        const idResult = await vault.setSecret('AWS_ACCESS_KEY_ID', newAccessKeyId);
        if (keyResult2.success && idResult.success) {
          console.log('   [OK] Stored AWS credentials in Ansible Vault');
        }
      } catch {
        console.log('   TIP: Store the secret key in Ansible Vault: npx stack deploy --secrets set AWS_SECRET_ACCESS_KEY');
      }
    } else {
      console.log('');
      console.log('   TIP: Store the secret key in Ansible Vault: npx stack deploy --secrets set AWS_SECRET_ACCESS_KEY');
    }

    return true;
  } catch (e) {
    console.log('   [!] Failed to create IAM user: ' + (e instanceof Error ? e.message : String(e)));
    console.log('   You may need to create the IAM user manually in the AWS Console.');
    return false;
  }
}

export const credentialsFixes: Fix[] = [
  {
    id: 'aws-account-not-setup',
    stage: 'dev',
    severity: 'critical',
    description: '☁️ AWS credentials not configured',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const awsConfig = getAwsConfig(config);
      if (!awsConfig.accessKeyId && !config.aws) {
        const { extractEnvironments } = await import('../../../../utils/config-helpers.js');
        const environments = extractEnvironments(config);
        const hasAwsEnv = Object.values(environments).some(
          (e: { access_key_id?: string; config?: string }) => !!e.access_key_id || !!e.config
        );
        if (!hasAwsEnv) return false;
      }

      const accountId = await getAwsAccountId(awsConfig.region);
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
    targetStage: 'prod',
    severity: 'warning',
    description: '🌍 AWS region not configured in stack.yml',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const { extractEnvironments } = await import('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);
      const hasAwsEnv = Object.values(environments).some(
        (e: { access_key_id?: string; config?: string }) => !!e.access_key_id || !!e.config
      );
      if (!hasAwsEnv && !config.aws) return false;

      const awsConfig = getAwsConfig(config);
      return !awsConfig.region || awsConfig.region === 'us-east-1' && !config.aws?.region;
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      try {
        // Try to read region from ~/.aws/config
        let region = readAwsRegionFromConfig() ?? '';

        if (!region) region = 'us-east-1'; // Safe default

        // Read stack.yml and add aws.region
        const stackPath = path.join(rootDir, 'stack.yml');
        if (!fs.existsSync(stackPath)) return false;

        let content = fs.readFileSync(stackPath, 'utf8');
        if (content.includes('aws:')) {
          // aws block exists — add region under it
          content = content.replace(/^(aws:.*)/m, '$1\n  region: ' + region);
        } else {
          // No aws block — add one
          content += '\naws:\n  region: ' + region + '\n';
        }
        fs.writeFileSync(stackPath, content, 'utf8');
        console.log('   [OK] Set aws.region to ' + region + ' in stack.yml');
        return true;
      } catch {
        return false;
      }
    },
    manualFix: 'Set aws.region in stack.yml under the prod environment or top-level aws block',
  },
  {
    id: 'aws-credentials-missing',
    stage: 'secrets',
    severity: 'critical',
    description: '🔑 AWS credentials not available (env vars or Ansible Vault)',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const { extractEnvironments } = await import('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);
      const hasAwsEnv = Object.values(environments).some(
        (e: { access_key_id?: string; config?: string }) => !!e.access_key_id || !!e.config
      );
      if (!hasAwsEnv && !config.aws) return false;

      if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
        return false;
      }

      if (config.ansible?.vault_path) {
        try {
          const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
          const vault = new AnsibleVaultSecrets({
            vault_path: config.ansible.vault_path,
            vault_password_file: config.ansible.vault_password_file,
          });
          const result = await vault.checkSecrets(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
          if (result.status?.AWS_ACCESS_KEY_ID && result.status?.AWS_SECRET_ACCESS_KEY) {
            return false;
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes('Integrity check failed') || msg.includes('wrong password')) return false;
          // Other vault errors — continue
        }
      }

      return true;
    },
    fix: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (!config.ansible?.vault_path) {
        console.log('   Ansible Vault not configured — cannot auto-store credentials');
        return false;
      }

      try {
        // Read from ~/.aws/credentials (set by aws configure)
        const awsCredsPath = path.join(os.homedir(), '.aws', 'credentials');
        if (!fs.existsSync(awsCredsPath)) {
          console.log('   ~/.aws/credentials not found — run "aws configure" first');
          return false;
        }

        const content = fs.readFileSync(awsCredsPath, 'utf8');
        const keyIdMatch = content.match(/aws_access_key_id\s*=\s*(.+)/);
        const secretMatch = content.match(/aws_secret_access_key\s*=\s*(.+)/);

        if (!keyIdMatch || !keyIdMatch[1] || !secretMatch || !secretMatch[1]) {
          console.log('   Could not read credentials from ~/.aws/credentials');
          return false;
        }

        const accessKeyId = keyIdMatch[1].trim();
        const secretKey = secretMatch[1].trim();

        const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
        const vault = new AnsibleVaultSecrets({
          vault_path: config.ansible.vault_path,
          vault_password_file: config.ansible.vault_password_file,
        });

        const r1 = await vault.setSecret('AWS_ACCESS_KEY_ID', accessKeyId);
        const r2 = await vault.setSecret('AWS_SECRET_ACCESS_KEY', secretKey);

        if (r1.success && r2.success) {
          console.log('   [OK] Stored AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY in Ansible Vault');
          return true;
        }

        console.log('   Failed to store in vault');
        return false;
      } catch (e) {
        console.log('   Error: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: [
      'Configure AWS credentials via one of:',
      '',
      '  Option A: Environment variables',
      '    export AWS_ACCESS_KEY_ID=AKIA...',
      '    export AWS_SECRET_ACCESS_KEY=...',
      '',
      '  Option B: AWS CLI + auto-store in vault',
      '    aws configure    (then run: npx stack fix --secrets)',
      '',
      '  Option C: Ansible Vault (manual)',
      '    npx stack deploy --secrets set AWS_ACCESS_KEY_ID',
      '    npx stack deploy --secrets set AWS_SECRET_ACCESS_KEY',
    ].join('\n'),
  },
  {
    id: 'aws-cli-not-configured-from-vault',
    stage: 'dev',
    severity: 'warning',
    description: '🔐 AWS CLI not configured on dev machine (credentials exist in vault)',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // Skip if not using AWS
      const { extractEnvironments } = await import('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);
      const hasAwsEnv = Object.values(environments).some(
        (e: { access_key_id?: string; config?: string }) => !!e.access_key_id || !!e.config
      );
      if (!hasAwsEnv && !config.aws) return false;

      // Skip if AWS CLI already configured
      const os = await import('os');
      const awsCredsPath = path.join(os.homedir(), '.aws', 'credentials');
      if (fs.existsSync(awsCredsPath)) {
        // Check if credentials are valid
        const content = fs.readFileSync(awsCredsPath, 'utf8');
        if (content.includes('aws_access_key_id')) {
          return false; // Already configured
        }
      }

      // Check if credentials exist in vault
      if (!config.ansible?.vault_path) return false;

      try {
        const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
        const vault = new AnsibleVaultSecrets({
          vault_path: config.ansible.vault_path,
          vault_password_file: config.ansible.vault_password_file,
        });
        const result = await vault.checkSecrets(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
        // Flag if credentials exist in vault but not in ~/.aws/credentials
        return !!(result.status?.AWS_ACCESS_KEY_ID && result.status?.AWS_SECRET_ACCESS_KEY);
      } catch {
        return false;
      }
    },
    fix: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (!config.ansible?.vault_path) {
        console.log('   Ansible Vault not configured');
        return false;
      }

      try {
        const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
        const vault = new AnsibleVaultSecrets({
          vault_path: config.ansible.vault_path,
          vault_password_file: config.ansible.vault_password_file,
        });

        const accessKeyId = await vault.getSecret('AWS_ACCESS_KEY_ID');
        const secretKey = await vault.getSecret('AWS_SECRET_ACCESS_KEY');

        if (!accessKeyId || !secretKey) {
          console.log('   AWS credentials not found in vault');
          return false;
        }

        const region = config.aws?.region ?? 'us-east-1';

        writeAwsCredentials(accessKeyId, secretKey, region);

        console.log('   ✅ Configured ~/.aws/credentials from Ansible Vault');
        console.log('   ✅ Configured ~/.aws/config (region: ' + region + ')');
        return true;
      } catch (e) {
        console.log('   Error: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Extract AWS credentials from vault and configure CLI:\n' +
      '    npx stack fix --dev',
  },
  {
    id: 'aws-credentials-invalid',
    stage: 'secrets',
    severity: 'warning',
    description: '🔑 AWS credentials are invalid or expired',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const awsConfig = getAwsConfig(config);
      const accountId = await getAwsAccountId(awsConfig.region);
      if (!accountId) {
        // Only flag if we have credentials configured (env vars or aws configure)
        if (process.env.AWS_ACCESS_KEY_ID) return true;
        try {
          // Check ~/.aws/credentials directly (no AWS CLI needed)
          const credPath = path.join(os.homedir(), '.aws', 'credentials');
          if (fs.existsSync(credPath)) {
            const content = fs.readFileSync(credPath, 'utf8');
            return /aws_access_key_id\s*=\s*\S+/.test(content);
          }
          return false;
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
