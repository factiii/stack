/**
 * AWS Credential Fixes
 *
 * Handles AWS credential sync, account setup, and validation.
 *
 * Order matters — aws-credentials-sync MUST be first:
 * 1. Sync vault → ~/.aws/credentials (ensure CLI uses the right project's key)
 * 2. Bootstrap if no credentials exist at all
 * 3. Region check
 * 4. Vault has credentials stored
 * 5. Credentials not expired
 * 6. Prod provisioning credentials valid
 *
 * See .spec/aws-iam.md for the full IAM user model.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import {
  getAwsAccountId,
  getCallerArn,
  getLocalAccessKeyId,
  getAwsConfig,
  getIAMClient,
  canManageIam,
  findIamUser,
  clearClientCache,
  setCredentialsSyncFailed,
  CreateUserCommand,
  PutUserPolicyCommand,
  CreateAccessKeyCommand,
  writeAwsCredentials,
  readAwsRegionFromConfig,
} from '../utils/aws-helpers.js';

/**
 * Check if this project uses AWS (shared guard for all credential fixes)
 */
async function isAwsProject(config: FactiiiConfig): Promise<boolean> {
  if (config.aws) return true;
  const { extractEnvironments } = await import('../../../../utils/config-helpers.js');
  const environments = extractEnvironments(config);
  return Object.values(environments).some(
    (e: { access_key_id?: string; config?: string }) => !!e.access_key_id || !!e.config
  );
}

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
  clearClientCache(); // Pick up new credentials

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
    clearClientCache(); // Pick up new IAM credentials

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

/**
 * Sync ~/.aws/credentials from vault, verifying it matches stack.yml.
 * Returns true if credentials are synced and valid, false otherwise.
 */
async function _syncCredentials(config: FactiiiConfig, rootDir: string): Promise<boolean> {
  const awsConfig = getAwsConfig(config);
  const configKeyId = awsConfig.accessKeyId!;
  const localKeyId = getLocalAccessKeyId();
  const region = awsConfig.region || 'us-east-1';

  if (localKeyId && localKeyId !== configKeyId) {
    console.log('');
    console.log('   ============================================================');
    console.log('   AWS CREDENTIAL MISMATCH');
    console.log('   ============================================================');
    console.log('   stack.yml access_key_id:   ' + configKeyId);
    console.log('   ~/.aws/credentials key:    ' + localKeyId);
    const identity = await getCallerArn(region);
    if (identity) {
      console.log('   Logged in as: ' + identity);
    }
    console.log('');
    console.log('   ~/.aws/credentials has keys from a different project.');
    console.log('   ============================================================');
  }

  // Try to sync from vault
  if (config.ansible?.vault_path) {
    try {
      const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
      const vault = new AnsibleVaultSecrets({
        vault_path: config.ansible.vault_path,
        vault_password_file: config.ansible.vault_password_file,
      });

      const vaultKeyId = await vault.getSecret('AWS_ACCESS_KEY_ID');
      const vaultSecret = await vault.getSecret('AWS_SECRET_ACCESS_KEY');

      if (!vaultKeyId || !vaultSecret) {
        console.log('   AWS credentials not found in vault');
        return false;
      }

      // Verify vault key matches stack.yml
      if (vaultKeyId !== configKeyId) {
        const { promptSingleLine } = await import('../../../../utils/secret-prompts.js');
        console.log('');
        console.log('   ============================================================');
        console.log('   VAULT / STACK.YML MISMATCH');
        console.log('   ============================================================');
        console.log('   Vault AWS_ACCESS_KEY_ID:    ' + vaultKeyId);
        console.log('   stack.yml access_key_id:    ' + configKeyId);
        console.log('   ============================================================');
        console.log('');
        console.log('   Which is correct?');
        console.log('   1) Vault is correct → update stack.yml to match vault');
        console.log('   2) stack.yml is correct → update vault (you will need the secret key)');
        console.log('');
        const choice = await promptSingleLine('   Enter 1 or 2: ');

        if (choice === '1') {
          // Update stack.yml access_key_id to match vault
          const stackPath = path.join(rootDir, 'stack.yml');
          if (fs.existsSync(stackPath)) {
            let content = fs.readFileSync(stackPath, 'utf8');
            content = content.replace(
              'access_key_id: ' + configKeyId,
              'access_key_id: ' + vaultKeyId
            );
            fs.writeFileSync(stackPath, content, 'utf8');
            console.log('   [OK] Updated stack.yml access_key_id to ' + vaultKeyId);

            // Now vault matches — write to ~/.aws/credentials
            writeAwsCredentials(vaultKeyId, vaultSecret, region);
            clearClientCache();

            const accountId = await getAwsAccountId(region);
            if (accountId) {
              const identity = await getCallerArn(region);
              console.log('   [OK] Synced ~/.aws/credentials from vault');
              console.log('   Logged in as: ' + (identity ?? vaultKeyId));
              return true;
            }
            console.log('   Vault credentials failed to authenticate');
            return false;
          }
          console.log('   stack.yml not found');
          return false;
        } else if (choice === '2') {
          // stack.yml is correct — prompt for secret key and store in vault
          console.log('');
          console.log('   Enter the AWS Secret Access Key for ' + configKeyId + ':');
          const newSecret = await promptSingleLine('   AWS Secret Access Key: ', { hidden: true });

          if (!newSecret) {
            console.log('   Secret Access Key is required.');
            return false;
          }

          const trimmedSecret = newSecret.trim();

          // Verify credentials by passing them explicitly to STS (don't rely on file cache)
          let verifyId: string | null = null;
          try {
            const { STSClient: STS, GetCallerIdentityCommand: GetId } = await import('@aws-sdk/client-sts');
            const sts = new STS({
              region,
              credentials: {
                accessKeyId: configKeyId,
                secretAccessKey: trimmedSecret,
              },
            });
            const result = await sts.send(new GetId({}));
            verifyId = result.Account ?? null;
          } catch (stsErr: unknown) {
            const errMsg = stsErr instanceof Error ? stsErr.message : String(stsErr);
            console.log('   Credentials invalid — check that the secret key matches ' + configKeyId);
            console.log('   AWS error: ' + errMsg);
            console.log('   TIP: New IAM keys can take ~10 seconds to propagate. Try again shortly.');
            return false;
          }
          if (!verifyId) {
            console.log('   Credentials invalid — no account ID returned');
            return false;
          }

          // Credentials verified — write to ~/.aws/credentials
          writeAwsCredentials(configKeyId, trimmedSecret, region);
          clearClientCache();

          const verifyIdentity = await getCallerArn(region);
          console.log('   [OK] Verified: ' + (verifyIdentity ?? configKeyId));

          // Store in vault
          try {
            const r1 = await vault.setSecret('AWS_ACCESS_KEY_ID', configKeyId);
            const r2 = await vault.setSecret('AWS_SECRET_ACCESS_KEY', newSecret);
            if (r1.success && r2.success) {
              console.log('   [OK] Stored credentials in Ansible Vault');
              return true;
            }
            console.log('   Failed to store in vault');
            return false;
          } catch (e2) {
            console.log('   Error storing in vault: ' + (e2 instanceof Error ? e2.message : String(e2)));
            return false;
          }
        } else {
          console.log('   Skipped — run npx stack fix again to retry');
          return false;
        }
      }

      // Vault matches stack.yml — write to ~/.aws/credentials
      writeAwsCredentials(vaultKeyId, vaultSecret, region);
      clearClientCache();

      // Verify the synced credentials work
      const accountId = await getAwsAccountId(region);
      if (!accountId) {
        console.log('   Synced credentials from vault but they failed to authenticate');
        console.log('   The credentials may be expired or deactivated in AWS');
        return false;
      }

      const identity = await getCallerArn(region);
      console.log('   [OK] Synced ~/.aws/credentials from vault');
      console.log('   Logged in as: ' + (identity ?? vaultKeyId));
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Integrity check failed') || msg.includes('wrong password')) {
        const { promptSingleLine } = await import('../../../../utils/secret-prompts.js');
        console.log('');
        console.log('   ============================================================');
        console.log('   VAULT PASSWORD INCORRECT');
        console.log('   ============================================================');
        console.log('   Cannot read AWS credentials — vault password in ~/.vault_pass');
        console.log('   does not match the password used to encrypt the vault.');
        console.log('');
        console.log('   Options:');
        console.log('   1) Enter the correct vault password now');
        console.log('   2) Recreate the vault (existing secrets will be lost)');
        console.log('   3) Skip for now (continue with other fixes)');
        console.log('   ============================================================');
        console.log('');
        const choice = await promptSingleLine('   Choose (1, 2, or 3): ');

        if (choice === '1') {
          const passFile = (config.ansible?.vault_password_file ?? '~/.vault_pass')
            .replace(/^~/, os.homedir());
          const vaultPath = config.ansible?.vault_path ?? '';
          const fullVaultPath = path.isAbsolute(vaultPath)
            ? vaultPath
            : path.join(rootDir, vaultPath);
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { Vault: VaultLib } = require('ansible-vault') as { Vault: new (opts: { password: string }) => { decryptSync: (data: string) => string } };
          const vaultContent = fs.readFileSync(fullVaultPath, 'utf8')
            .replace(/^\uFEFF/, '')
            .trim();

          const maxAttempts = 3;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const newPass = await promptSingleLine('   Enter the correct vault password (' + attempt + '/' + maxAttempts + '): ', { hidden: true });
            if (!newPass) {
              console.log('   No password entered');
              if (attempt < maxAttempts) continue;
              break;
            }

            try {
              const v = new VaultLib({ password: newPass });
              v.decryptSync(vaultContent);

              // Success — write the password
              fs.writeFileSync(passFile, newPass + '\n', { mode: 0o600 });
              console.log('   [OK] Updated ' + passFile + ' — retrying sync...');
              return await _syncCredentials(config, rootDir);
            } catch {
              if (attempt < maxAttempts) {
                console.log('   [!] Wrong password — try again');
              }
            }
          }

          // All attempts failed — auto-skip
          console.log('   [!] 3 failed attempts — skipping vault for now');
          setCredentialsSyncFailed();
          return true;
        }

        if (choice === '2') {
          const vaultPath = config.ansible?.vault_path ?? '';
          const fullVaultPath = path.isAbsolute(vaultPath)
            ? vaultPath
            : path.join(rootDir, vaultPath);
          const backupPath = fullVaultPath + '.bak.' + Date.now();
          try {
            fs.copyFileSync(fullVaultPath, backupPath);
            console.log('   Backed up old vault → ' + backupPath);
          } catch {
            // Continue even if backup fails
          }
          try {
            fs.unlinkSync(fullVaultPath);
            const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
            const vault = new AnsibleVaultSecrets({
              vault_path: vaultPath,
              vault_password_file: config.ansible?.vault_password_file ?? '~/.vault_pass',
              rootDir,
            });
            await vault.setSecret('_initialized', 'true');
            console.log('   [OK] Created new vault with current password');
            console.log('   [!] You will need to re-store AWS credentials and other secrets');
            return false; // Still need to re-populate credentials
          } catch (e2) {
            console.log('   [!] Failed to create new vault: ' + (e2 instanceof Error ? e2.message : String(e2)));
            return false;
          }
        }

        if (choice === '3') {
          console.log('   [--] Skipping vault — continuing with other fixes');
          setCredentialsSyncFailed();
          return true; // Return true so blocking doesn't halt remaining fixes
        }

        return false;
      } else {
        console.log('   Error reading vault: ' + msg);
      }
      return false;
    }
  }

  // No vault — can't auto-fix
  console.log('');
  console.log('   To fix, store the correct credentials in the vault:');
  console.log('     npx stack deploy --secrets set AWS_ACCESS_KEY_ID');
  console.log('     npx stack deploy --secrets set AWS_SECRET_ACCESS_KEY');
  console.log('   Then run: npx stack fix');
  return false;
}

// CRITICAL: aws-credentials-sync MUST be the first fix in this array.
// It ensures ~/.aws/credentials matches stack.yml before any other AWS operation runs.
// See .spec/aws-iam.md for why.
export const credentialsFixes: Fix[] = [
  {
    id: 'aws-credentials-sync',
    stage: 'dev',
    severity: 'critical',
    blocking: true,
    description: '🔑 AWS credentials out of sync (vault → ~/.aws/credentials)',
    scan: async function (this: Fix, config: FactiiiConfig, _rootDir: string): Promise<boolean> {
      if (!(await isAwsProject(config))) return false;

      const awsConfig = getAwsConfig(config);
      const configKeyId = awsConfig.accessKeyId;
      if (!configKeyId) return false; // No access_key_id in stack.yml — nothing to sync against

      // Read what ~/.aws/credentials currently has
      const localKeyId = getLocalAccessKeyId();

      // Case 1: ~/.aws/credentials matches stack.yml — already synced
      if (localKeyId === configKeyId) return false;

      // Case 2: ~/.aws/credentials is missing or has a different key — needs sync
      // Try to silently sync from vault so downstream scans can authenticate
      if (config.ansible?.vault_path) {
        try {
          const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
          const vault = new AnsibleVaultSecrets({
            vault_path: config.ansible.vault_path,
            vault_password_file: config.ansible.vault_password_file,
          });
          const vaultKeyId = await vault.getSecret('AWS_ACCESS_KEY_ID');
          const vaultSecret = await vault.getSecret('AWS_SECRET_ACCESS_KEY');

          if (vaultKeyId && vaultSecret) {
            if (vaultKeyId === configKeyId) {
              // Vault matches stack.yml — sync silently so downstream scans work
              writeAwsCredentials(vaultKeyId, vaultSecret, awsConfig.region || 'us-east-1');
              clearClientCache();
              return false; // Synced, no issue
            }
            // Vault doesn't match stack.yml — needs user intervention (fix will handle)
            return true;
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes('Integrity check failed') || msg.includes('wrong password')) {
            // Vault password is wrong — flag so fix can show clear guidance
            return true;
          }
          // Other vault errors — fall through
        }
      }

      // No vault credentials — still flag if there's a mismatch
      if (localKeyId && localKeyId !== configKeyId) {
        return true;
      }

      return false;
    },
    fix: async function (config: FactiiiConfig, _rootDir: string): Promise<boolean> {
      const result = await _syncCredentials(config, _rootDir);
      if (!result) setCredentialsSyncFailed();
      return result;
    },
    manualFix: [
      'AWS credentials in ~/.aws/credentials do not match stack.yml access_key_id.',
      'The vault is the source of truth — sync by running:',
      '  npx stack fix --dev',
      '',
      'Or update vault credentials manually:',
      '  npx stack deploy --secrets set AWS_ACCESS_KEY_ID',
      '  npx stack deploy --secrets set AWS_SECRET_ACCESS_KEY',
    ].join('\n'),
  },
  {
    id: 'aws-account-not-setup',
    stage: 'dev',
    severity: 'critical',
    description: '☁️ AWS credentials not configured',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (!(await isAwsProject(config))) return false;

      const awsConfig = getAwsConfig(config);
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
      if (!(await isAwsProject(config))) return false;

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
      if (!(await isAwsProject(config))) return false;

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
        // Read from ~/.aws/credentials (set by aws configure or vault sync)
        const awsCredsPath = path.join(os.homedir(), '.aws', 'credentials');
        if (!fs.existsSync(awsCredsPath)) {
          console.log('   ~/.aws/credentials not found — run "npx stack fix --dev" first');
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
      '  Option B: Store in Ansible Vault',
      '    npx stack deploy --secrets set AWS_ACCESS_KEY_ID',
      '    npx stack deploy --secrets set AWS_SECRET_ACCESS_KEY',
    ].join('\n'),
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
  {
    id: 'aws-prod-credentials-ready',
    stage: 'prod',
    severity: 'critical',
    description: '🔑 AWS credentials not valid for prod provisioning',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (!(await isAwsProject(config))) return false;

      const awsConfig = getAwsConfig(config);
      const accountId = await getAwsAccountId(awsConfig.region);
      if (accountId) {
        // Credentials work — but check if we're using a scoped user that lacks provisioning perms
        const callerIdentity = await getCallerArn(awsConfig.region);
        if (!callerIdentity) return false;

        // Extract username from formatted string "userName (AKIA...)"
        const currentUser = callerIdentity.includes(' (')
          ? (callerIdentity.split(' (')[0] ?? callerIdentity)
          : callerIdentity;

        // Admin and root are fine for provisioning
        if (currentUser === 'factiii-admin' || callerIdentity.includes(':root')) return false;
        // Scoped users (factiii-xxx-dev, factiii-xxx-prod) lack VPC/EC2 create permissions
        if (currentUser.startsWith('factiii-') &&
            (currentUser.endsWith('-dev') || currentUser.endsWith('-prod'))) {
          return true; // Wrong user for provisioning
        }
        return false;
      }
      // No valid credentials at all
      return true;
    },
    fix: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const awsConfig = getAwsConfig(config);
      const region = awsConfig.region || 'us-east-1';

      // Try to restore admin credentials from vault
      if (config.ansible?.vault_path) {
        try {
          const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
          const vault = new AnsibleVaultSecrets({
            vault_path: config.ansible.vault_path,
            vault_password_file: config.ansible.vault_password_file,
          });

          const check = await vault.checkSecrets(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
          if (check.status?.AWS_ACCESS_KEY_ID && check.status?.AWS_SECRET_ACCESS_KEY) {
            const accessKeyId = await vault.getSecret('AWS_ACCESS_KEY_ID');
            const secretKey = await vault.getSecret('AWS_SECRET_ACCESS_KEY');

            if (accessKeyId && secretKey) {
              writeAwsCredentials(accessKeyId, secretKey, region);
              clearClientCache();

              const newAccountId = await getAwsAccountId(region);
              if (newAccountId) {
                const newArn = await getCallerArn(region);
                console.log('   [OK] Restored AWS credentials from vault');
                console.log('   Logged in as: ' + (newArn ?? 'unknown'));

                // Verify the restored user has provisioning permissions
                if (await canManageIam(region)) {
                  return true;
                }
                console.log('   [!] Vault credentials lack IAM permissions — may need admin credentials');
              }
            }
          }
        } catch {
          // Vault read failed
        }
      }

      // Vault didn't work — prompt for admin credentials
      console.log('');
      console.log('   ============================================================');
      console.log('   AWS admin credentials needed for prod provisioning');
      console.log('   ============================================================');
      console.log('   Prod provisioning (VPC, EC2, RDS, etc.) requires admin access.');
      console.log('   Enter the factiii-admin Access Key ID and Secret Access Key.');
      console.log('   ============================================================');
      console.log('');

      const { promptSingleLine } = await import('../../../../utils/secret-prompts.js');
      const inputAccessKeyId = await promptSingleLine('   AWS Access Key ID: ');
      const inputSecretKey = await promptSingleLine('   AWS Secret Access Key: ', { hidden: true });

      if (!inputAccessKeyId || !inputSecretKey) {
        console.log('   Access Key ID and Secret Access Key are required.');
        return false;
      }

      writeAwsCredentials(inputAccessKeyId, inputSecretKey, region);
      clearClientCache();

      const verifyId = await getAwsAccountId(region);
      if (!verifyId) {
        console.log('   Credentials invalid.');
        return false;
      }

      const verifyArn = await getCallerArn(region);
      console.log('   [OK] Logged in as: ' + (verifyArn ?? 'unknown'));

      // Store in vault for future use
      if (config.ansible?.vault_path) {
        try {
          const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
          const vault = new AnsibleVaultSecrets({
            vault_path: config.ansible.vault_path,
            vault_password_file: config.ansible.vault_password_file,
          });
          await vault.setSecret('AWS_ACCESS_KEY_ID', inputAccessKeyId);
          await vault.setSecret('AWS_SECRET_ACCESS_KEY', inputSecretKey);
          console.log('   [OK] Stored credentials in Ansible Vault');
        } catch {
          console.log('   TIP: Store in vault: npx stack deploy --secrets set AWS_ACCESS_KEY_ID');
        }
      }

      return true;
    },
    manualFix: 'Configure AWS admin credentials:\n' +
      '  npx stack deploy --secrets set AWS_ACCESS_KEY_ID\n' +
      '  npx stack deploy --secrets set AWS_SECRET_ACCESS_KEY\n' +
      '  Then: npx stack fix --dev',
  },
];
