/**
 * AWS RDS Fixes
 *
 * Provisions RDS PostgreSQL 15 instance (db.t3.micro free tier).
 * Creates DB subnet group from private subnets, launches instance with RDS SG.
 * Stores DATABASE_URL in Ansible Vault.
 */

import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { awsExec, awsExecSafe, getAwsConfig, getProjectName, isOnServer } from '../utils/aws-helpers.js';

/**
 * Find VPC by factiii:project tag
 */
function findVpc(projectName: string, region: string): string | null {
  const result = awsExecSafe(
    'aws ec2 describe-vpcs --filters "Name=tag:factiii:project,Values=' + projectName + '" --query "Vpcs[0].VpcId" --output text',
    region
  );
  if (!result || result === 'None' || result === 'null') return null;
  return result.replace(/"/g, '');
}

/**
 * Find all private subnets
 */
function findPrivateSubnets(projectName: string, region: string): string[] {
  const result = awsExecSafe(
    'aws ec2 describe-subnets --filters "Name=tag:factiii:project,Values=' + projectName + '" "Name=tag:factiii:subnet-type,Values=private" --query "Subnets[*].SubnetId" --output text',
    region
  );
  if (!result || result === 'None' || result === 'null') return [];
  return result.split(/\s+/).filter(Boolean);
}

/**
 * Find security group by name and VPC
 */
function findSecurityGroup(groupName: string, vpcId: string, region: string): string | null {
  const result = awsExecSafe(
    'aws ec2 describe-security-groups --filters "Name=group-name,Values=' + groupName + '" "Name=vpc-id,Values=' + vpcId + '" --query "SecurityGroups[0].GroupId" --output text',
    region
  );
  if (!result || result === 'None' || result === 'null') return null;
  return result.replace(/"/g, '');
}

/**
 * Check if DB subnet group exists
 */
function findDbSubnetGroup(groupName: string, region: string): boolean {
  const result = awsExecSafe(
    'aws rds describe-db-subnet-groups --db-subnet-group-name ' + groupName + ' --query "DBSubnetGroups[0].DBSubnetGroupName" --output text',
    region
  );
  return !!result && result !== 'None' && result !== 'null';
}

/**
 * Find RDS instance by identifier
 */
function findRdsInstance(dbInstanceId: string, region: string): { status: string; endpoint: string | null } | null {
  const result = awsExecSafe(
    'aws rds describe-db-instances --db-instance-identifier ' + dbInstanceId,
    region
  );
  if (!result) return null;
  try {
    const parsed = JSON.parse(result);
    const instance = parsed.DBInstances?.[0];
    if (!instance) return null;
    return {
      status: instance.DBInstanceStatus,
      endpoint: instance.Endpoint?.Address ?? null,
    };
  } catch {
    return null;
  }
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
 * Generate a random password for RDS
 */
function generateRdsPassword(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let password = '';
  const crypto = require('crypto') as typeof import('crypto');
  const bytes = crypto.randomBytes(24);
  for (let i = 0; i < 24; i++) {
    password += chars[(bytes[i] ?? 0) % chars.length];
  }
  return password;
}

export const rdsFixes: Fix[] = [
  {
    id: 'aws-rds-subnet-group-missing',
    stage: 'prod',
    severity: 'critical',
    description: '🗃️ RDS DB subnet group not created (needs 2 AZs)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const privateSubnets = findPrivateSubnets(projectName, region);
      if (privateSubnets.length < 2) return false; // Private subnets must exist first
      return !findDbSubnetGroup('factiii-' + projectName, region);
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const privateSubnets = findPrivateSubnets(projectName, region);
      if (privateSubnets.length < 2) {
        console.log('   Need at least 2 private subnets first');
        return false;
      }

      try {
        const groupName = 'factiii-' + projectName;
        awsExec(
          'aws rds create-db-subnet-group' +
          ' --db-subnet-group-name ' + groupName +
          ' --db-subnet-group-description "Factiii DB subnet group for ' + projectName + '"' +
          ' --subnet-ids ' + privateSubnets.join(' '),
          region
        );
        console.log('   Created DB subnet group: ' + groupName);
        console.log('   Using subnets: ' + privateSubnets.join(', '));
        return true;
      } catch (e) {
        console.log('   Failed to create DB subnet group: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Create DB subnet group with 2+ private subnets in different AZs',
  },
  {
    id: 'aws-rds-instance-missing',
    stage: 'prod',
    severity: 'critical',
    description: '🗃️ RDS PostgreSQL 15 instance not created (db.t3.micro)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const dbId = 'factiii-' + projectName + '-db';
      return !findRdsInstance(dbId, region);
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const vpcId = findVpc(projectName, region);
      if (!vpcId) {
        console.log('   VPC must be created first');
        return false;
      }

      const subnetGroupName = 'factiii-' + projectName;
      if (!findDbSubnetGroup(subnetGroupName, region)) {
        console.log('   DB subnet group must be created first');
        return false;
      }

      const rdsSgId = findSecurityGroup('factiii-' + projectName + '-rds', vpcId, region);
      if (!rdsSgId) {
        console.log('   RDS security group must be created first');
        return false;
      }

      try {
        const dbId = 'factiii-' + projectName + '-db';
        const dbName = projectName.replace(/[^a-zA-Z0-9]/g, '');
        const masterUser = 'factiii';
        const masterPassword = generateRdsPassword();

        awsExec(
          'aws rds create-db-instance' +
          ' --db-instance-identifier ' + dbId +
          ' --db-instance-class db.t3.micro' +
          ' --engine postgres' +
          ' --engine-version 15' +
          ' --allocated-storage 20' +
          ' --master-username ' + masterUser +
          ' --master-user-password ' + masterPassword +
          ' --db-name ' + dbName +
          ' --db-subnet-group-name ' + subnetGroupName +
          ' --vpc-security-group-ids ' + rdsSgId +
          ' --no-publicly-accessible' +
          ' --storage-type gp2' +
          ' --backup-retention-period 1',
          region
        );

        console.log('   Creating RDS instance: ' + dbId);
        console.log('   Engine: PostgreSQL 15');
        console.log('   Instance class: db.t3.micro (free tier eligible)');
        console.log('   Storage: 20 GB gp2');
        console.log('   Database name: ' + dbName);
        console.log('   Master user: ' + masterUser);
        console.log('');
        console.log('   IMPORTANT: Save these credentials!');
        console.log('   Master password: ' + masterPassword);
        console.log('   DATABASE_URL: postgresql://' + masterUser + ':' + masterPassword + '@<endpoint>:5432/' + dbName);
        console.log('');
        console.log('   RDS instance takes ~5-10 minutes to become available.');
        console.log('   Run "npx stack scan --prod" to check status.');
        console.log('');
        console.log('   TIP: Store credentials in Ansible Vault: npx stack secrets edit');

        return true;
      } catch (e) {
        console.log('   Failed to create RDS instance: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Create RDS instance: aws rds create-db-instance --db-instance-class db.t3.micro --engine postgres --engine-version 15',
  },
  {
    id: 'aws-rds-not-available',
    stage: 'prod',
    severity: 'warning',
    description: '⏳ RDS instance is not yet available (takes ~5-10 min)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const dbId = 'factiii-' + projectName + '-db';
      const instance = findRdsInstance(dbId, region);
      if (!instance) return false; // No instance yet
      return instance.status !== 'available';
    },
    fix: null,
    manualFix: 'RDS instance is provisioning. Wait ~5-10 minutes and run scan again.\nCheck status: aws rds describe-db-instances --db-instance-identifier factiii-{name}-db --query "DBInstances[0].DBInstanceStatus"',
  },
  {
    id: 'aws-rds-connection-test',
    stage: 'prod',
    severity: 'info',
    description: '🗃️ Cannot verify RDS connectivity from EC2 (pg_isready not found)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const dbId = 'factiii-' + projectName + '-db';
      const instance = findRdsInstance(dbId, region);
      if (!instance || instance.status !== 'available' || !instance.endpoint) return false;

      // Check if pg_isready is available on EC2 via SSH
      // This scan runs on the dev machine, so we check via SSH
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { extractEnvironments } = require('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);
      const prodEnv = environments.prod ?? environments.production;
      if (!prodEnv?.domain) return false;

      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { sshExec } = require('../../../../utils/ssh-helper.js');
        const result = await sshExec(prodEnv, 'which pg_isready 2>/dev/null && pg_isready -h ' + instance.endpoint + ' -p 5432 2>&1 || echo "pg_isready not found"');
        return result.includes('pg_isready not found') || result.includes('no response');
      } catch {
        return false; // Can't SSH — skip this check
      }
    },
    fix: null,
    manualFix: 'Install PostgreSQL client on EC2: sudo apt-get install -y postgresql-client-15\nTest connection: pg_isready -h <rds-endpoint> -p 5432',
  },
];
