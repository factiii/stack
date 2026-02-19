/**
 * AWS DB Replication Fixes
 *
 * Prereq checks for DB replication between staging (Mac Mini) and prod (RDS).
 * Ensures PostgreSQL client is available on EC2 and RDS is reachable.
 *
 * Actual sync commands are in the AWS pipeline index.ts as plugin commands:
 * - `db sync-to-prod`: pg_dump Mac Mini → SCP to EC2 → pg_restore into RDS
 * - `db sync-to-staging`: pg_dump RDS via EC2 → SCP to Mac Mini → pg_restore
 */

import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { awsExecSafe, getAwsConfig, getProjectName, isOnServer } from '../utils/aws-helpers.js';

/**
 * Find RDS instance endpoint
 */
function findRdsEndpoint(projectName: string, region: string): string | null {
  const dbId = 'factiii-' + projectName + '-db';
  const result = awsExecSafe(
    'aws rds describe-db-instances --db-instance-identifier ' + dbId +
    ' --query "DBInstances[0].Endpoint.Address" --output text',
    region
  );
  if (!result || result === 'None' || result === 'null') return null;
  return result.replace(/"/g, '');
}

/**
 * Check if AWS is configured for this project
 */
function isAwsConfigured(config: FactiiiConfig): boolean {
  if (isOnServer()) return false;
  if (config.aws) return true;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { extractEnvironments } = require('../../../../utils/config-helpers.js');
  const environments = extractEnvironments(config);
  return Object.values(environments).some(
    (e: unknown) => (e as { pipeline?: string }).pipeline === 'aws'
  );
}

/**
 * Get prod environment config
 */
function getProdEnv(config: FactiiiConfig): { domain?: string; ssh_user?: string } | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { extractEnvironments } = require('../../../../utils/config-helpers.js');
  const environments = extractEnvironments(config);
  return environments.prod ?? environments.production ?? null;
}

export const dbReplicationFixes: Fix[] = [
  {
    id: 'aws-rds-ec2-pg-client-missing',
    stage: 'prod',
    severity: 'warning',
    description: 'PostgreSQL client not installed on EC2 (needed for DB sync)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);

      // Only check if RDS exists
      const endpoint = findRdsEndpoint(projectName, region);
      if (!endpoint) return false;

      // Check if pg_dump is available on EC2 via SSH
      const prodEnv = getProdEnv(config);
      if (!prodEnv?.domain || prodEnv.domain.startsWith('EXAMPLE-')) return false;

      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { sshExec } = require('../../../../utils/ssh-helper.js');
        const result = await sshExec(prodEnv, 'which pg_dump 2>/dev/null || echo "not_found"');
        return result.trim() === 'not_found';
      } catch {
        return false; // Can't SSH — skip
      }
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const prodEnv = getProdEnv(config);
      if (!prodEnv?.domain) {
        console.log('   Production domain not configured');
        return false;
      }

      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { sshExec } = require('../../../../utils/ssh-helper.js');
        console.log('   Installing PostgreSQL 15 client on EC2...');
        await sshExec(prodEnv, 'sudo apt-get update -qq && sudo apt-get install -y postgresql-client-15');
        console.log('   PostgreSQL client installed');
        return true;
      } catch (e) {
        console.log('   Failed to install pg client: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'SSH to EC2 and run: sudo apt-get install -y postgresql-client-15',
  },
  {
    id: 'aws-rds-connectivity',
    stage: 'prod',
    severity: 'critical',
    description: 'EC2 cannot connect to RDS (check security groups)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);

      const endpoint = findRdsEndpoint(projectName, region);
      if (!endpoint) return false;

      const prodEnv = getProdEnv(config);
      if (!prodEnv?.domain || prodEnv.domain.startsWith('EXAMPLE-')) return false;

      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { sshExec } = require('../../../../utils/ssh-helper.js');
        // Check if pg_isready is available first
        const hasPg = await sshExec(prodEnv, 'which pg_isready 2>/dev/null || echo "not_found"');
        if (hasPg.trim() === 'not_found') return false; // Can't test without pg client

        const result = await sshExec(prodEnv, 'pg_isready -h ' + endpoint + ' -p 5432 2>&1');
        return !result.includes('accepting connections');
      } catch {
        return false;
      }
    },
    fix: null,
    manualFix: [
      'EC2 cannot reach RDS. Check:',
      '1. RDS security group allows port 5432 from EC2 security group',
      '2. RDS is in the same VPC as EC2',
      '3. RDS instance status is "available"',
      '4. Test: ssh to EC2, run: pg_isready -h <rds-endpoint> -p 5432',
    ].join('\n'),
  },
];
