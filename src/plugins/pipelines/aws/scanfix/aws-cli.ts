/**
 * AWS CLI fixes for AWS plugin
 *
 * AWS CLI is still needed for ECR Docker login (aws ecr get-login-password).
 * All other AWS operations now use the AWS SDK.
 */

import { execSync } from 'child_process';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';

/**
 * Check if any environment uses AWS pipeline
 */
function hasAwsPipeline(config: FactiiiConfig): boolean {
  if (config.aws) return true;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { extractEnvironments } = require('../../../../utils/config-helpers.js');
  const environments = extractEnvironments(config);
  return Object.values(environments).some(
    (e: unknown) => (e as { pipeline?: string; access_key_id?: string }).pipeline === 'aws' ||
      (e as { access_key_id?: string }).access_key_id
  );
}

/**
 * Check if AWS CLI is installed
 */
function isAwsCliInstalled(): boolean {
  try {
    execSync('aws --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Auto-install AWS CLI based on platform
 */
function installAwsCli(): boolean {
  const platform = process.platform;

  try {
    if (platform === 'darwin') {
      console.log('   Installing AWS CLI via Homebrew...');
      execSync('brew install awscli', { stdio: 'inherit' });
      return true;
    }

    if (platform === 'linux') {
      try {
        execSync('which apt-get', { stdio: 'pipe' });
        console.log('   Installing AWS CLI via apt...');
        execSync('sudo apt-get update && sudo apt-get install -y awscli', { stdio: 'inherit' });
        return true;
      } catch {
        // Not apt-based, use AWS installer
      }

      console.log('   Installing AWS CLI via official installer...');
      execSync(
        'curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "/tmp/awscliv2.zip"' +
        ' && unzip -o /tmp/awscliv2.zip -d /tmp/aws-install' +
        ' && sudo /tmp/aws-install/aws/install' +
        ' && rm -rf /tmp/awscliv2.zip /tmp/aws-install',
        { stdio: 'inherit' }
      );
      return true;
    }

    if (platform === 'win32') {
      console.log('   Installing AWS CLI via winget...');
      execSync('winget install Amazon.AWSCLI', { stdio: 'inherit' });
      return true;
    }

    console.log('   Unsupported platform: ' + platform);
    return false;
  } catch (e) {
    console.log('   Failed to install AWS CLI: ' + (e instanceof Error ? e.message : String(e)));
    return false;
  }
}

export const awsCliFixes: Fix[] = [
  {
    id: 'aws-cli-not-installed-dev',
    stage: 'dev',
    severity: 'warning',
    description: '🔧 AWS CLI not installed (needed for ECR Docker login)',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      if (!hasAwsPipeline(config)) return false;
      return !isAwsCliInstalled();
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      return installAwsCli();
    },
    manualFix: [
      'Install AWS CLI:',
      '  macOS:   brew install awscli',
      '  Linux:   sudo apt-get install awscli  (or curl installer from AWS)',
      '  Windows: winget install Amazon.AWSCLI',
    ].join('\n'),
  },
];
