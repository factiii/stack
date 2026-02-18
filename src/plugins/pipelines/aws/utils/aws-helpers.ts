/**
 * AWS Helper Utilities
 *
 * Shared functions for AWS CLI operations used across all AWS scanfix files.
 * All functions use AWS CLI via execSync (no SDK dependency).
 */

import { execSync } from 'child_process';
import type { FactiiiConfig, EnvironmentConfig } from '../../../../types/index.js';

/**
 * Execute an AWS CLI command with region injection
 * Returns the stdout as a trimmed string
 * Throws on failure
 */
export function awsExec(cmd: string, region?: string): string {
  const regionFlag = region ? ' --region ' + region : '';
  const fullCmd = cmd + regionFlag + ' --output json';
  try {
    return execSync(fullCmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error('AWS CLI failed: ' + msg);
  }
}

/**
 * Execute an AWS CLI command, returning null on failure instead of throwing
 */
export function awsExecSafe(cmd: string, region?: string): string | null {
  try {
    return awsExec(cmd, region);
  } catch {
    return null;
  }
}

/**
 * Find an AWS resource by its factiii:project tag
 * Returns the resource data as parsed JSON, or null if not found
 */
export function findResourceByTag(
  describeCmd: string,
  projectName: string,
  region: string
): unknown | null {
  try {
    const result = awsExec(
      describeCmd + ' --filters "Name=tag:factiii:project,Values=' + projectName + '"',
      region
    );
    const parsed = JSON.parse(result);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Generate --tag-specifications string for AWS resource creation
 * Tags resources with factiii:project={name} and factiii:managed=true
 */
export function tagSpec(resourceType: string, projectName: string, extraTags?: Record<string, string>): string {
  let tags = '{Key=factiii:project,Value=' + projectName + '},{Key=factiii:managed,Value=true},{Key=Name,Value=factiii-' + projectName + '}';

  if (extraTags) {
    for (const [key, value] of Object.entries(extraTags)) {
      tags += ',{Key=' + key + ',Value=' + value + '}';
    }
  }

  return '--tag-specifications ResourceType=' + resourceType + ',Tags=[' + tags + ']';
}

/**
 * Extract AWS configuration from a FactiiiConfig
 * Checks both top-level config.aws and per-environment aws settings
 */
export function getAwsConfig(config: FactiiiConfig): {
  region: string;
  configType: string;
  accessKeyId?: string;
} {
  // Check top-level aws config first
  const topLevel = config.aws as Record<string, unknown> | undefined;
  if (topLevel) {
    return {
      region: (topLevel.region as string) ?? 'us-east-1',
      configType: (topLevel.config as string) ?? 'ec2',
      accessKeyId: topLevel.access_key_id as string | undefined,
    };
  }

  // Check per-environment configs
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

  // Default
  return { region: 'us-east-1', configType: 'ec2' };
}

/**
 * Check if AWS CLI is installed and accessible
 */
export function isAwsCliInstalled(): boolean {
  try {
    execSync('aws --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if AWS credentials are configured and valid
 * Returns the account ID if valid, null otherwise
 */
export function getAwsAccountId(region?: string): string | null {
  try {
    const result = awsExec('aws sts get-caller-identity --query Account --output text', region);
    // The output text mode returns without JSON wrapping
    return result.replace(/"/g, '').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get the project name for tagging (from config.name)
 */
export function getProjectName(config: FactiiiConfig): string {
  return config.name ?? 'app';
}
