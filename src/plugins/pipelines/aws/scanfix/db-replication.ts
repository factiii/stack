/**
 * AWS DB Replication Fixes
 *
 * Prereq checks for DB replication between staging (Mac Mini) and prod (RDS).
 * Ensures PostgreSQL client is available on EC2 and RDS is reachable.
 * Uses AWS SDK v3.
 */

import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import {
  getAwsConfig,
  getProjectName,
  isAwsConfigured,
  findRdsEndpoint,
} from '../utils/aws-helpers.js';

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
    description: '🔄 PostgreSQL client not installed on EC2 (needed for DB sync)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);

      const endpoint = await findRdsEndpoint(projectName, region);
      if (!endpoint) return false;

      const prodEnv = getProdEnv(config);
      if (!prodEnv?.domain || prodEnv.domain.toUpperCase().startsWith('EXAMPLE')) return false;

      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { sshExec } = require('../../../../utils/ssh-helper.js');
        const result = await sshExec(prodEnv, 'which pg_dump 2>/dev/null || echo "not_found"');
        return result.trim() === 'not_found';
      } catch {
        return false;
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
    description: '🔄 EC2 cannot connect to RDS (check security groups)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);

      const endpoint = await findRdsEndpoint(projectName, region);
      if (!endpoint) return false;

      const prodEnv = getProdEnv(config);
      if (!prodEnv?.domain || prodEnv.domain.toUpperCase().startsWith('EXAMPLE')) return false;

      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { sshExec } = require('../../../../utils/ssh-helper.js');
        const hasPg = await sshExec(prodEnv, 'which pg_isready 2>/dev/null || echo "not_found"');
        if (hasPg.trim() === 'not_found') return false;

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
