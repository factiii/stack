/**
 * AWS RDS Fixes
 *
 * Provisions RDS PostgreSQL 15 instance (db.t3.micro free tier).
 * Creates DB subnet group from private subnets, launches instance with RDS SG.
 * Stores DATABASE_URL in Ansible Vault.
 * Uses AWS SDK v3.
 */

import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import {
  getAwsConfig,
  getProjectName,
  isAwsConfigured,
  findVpc,
  findPrivateSubnets,
  findSecurityGroup,
  findDbSubnetGroup,
  findRdsInstance,
  getRDSClient,
  CreateDBSubnetGroupCommand,
  CreateDBInstanceCommand,
} from '../utils/aws-helpers.js';

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
      const privateSubnets = await findPrivateSubnets(projectName, region);
      if (privateSubnets.length < 2) return false;
      return !(await findDbSubnetGroup('factiii-' + projectName, region));
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const privateSubnets = await findPrivateSubnets(projectName, region);
      if (privateSubnets.length < 2) {
        console.log('   Need at least 2 private subnets first');
        return false;
      }

      try {
        const rds = getRDSClient(region);
        const groupName = 'factiii-' + projectName;

        await rds.send(new CreateDBSubnetGroupCommand({
          DBSubnetGroupName: groupName,
          DBSubnetGroupDescription: 'Factiii DB subnet group for ' + projectName,
          SubnetIds: privateSubnets,
        }));
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
      return !(await findRdsInstance(dbId, region));
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const vpcId = await findVpc(projectName, region);
      if (!vpcId) {
        console.log('   VPC must be created first');
        return false;
      }

      const subnetGroupName = 'factiii-' + projectName;
      if (!(await findDbSubnetGroup(subnetGroupName, region))) {
        console.log('   DB subnet group must be created first');
        return false;
      }

      const rdsSgId = await findSecurityGroup('factiii-' + projectName + '-rds', vpcId, region);
      if (!rdsSgId) {
        console.log('   RDS security group must be created first');
        return false;
      }

      try {
        const rds = getRDSClient(region);
        const dbId = 'factiii-' + projectName + '-db';
        const dbName = projectName.replace(/[^a-zA-Z0-9]/g, '');
        const masterUser = 'factiii';
        const masterPassword = generateRdsPassword();

        await rds.send(new CreateDBInstanceCommand({
          DBInstanceIdentifier: dbId,
          DBInstanceClass: 'db.t3.micro',
          Engine: 'postgres',
          EngineVersion: '15',
          AllocatedStorage: 20,
          MasterUsername: masterUser,
          MasterUserPassword: masterPassword,
          DBName: dbName,
          DBSubnetGroupName: subnetGroupName,
          VpcSecurityGroupIds: [rdsSgId],
          PubliclyAccessible: false,
          StorageType: 'gp2',
          BackupRetentionPeriod: 1,
        }));

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
      const instance = await findRdsInstance(dbId, region);
      if (!instance) return false;
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
      const instance = await findRdsInstance(dbId, region);
      if (!instance || instance.status !== 'available' || !instance.endpoint) return false;

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
        return false;
      }
    },
    fix: null,
    manualFix: 'Install PostgreSQL client on EC2: sudo apt-get install -y postgresql-client-15\nTest connection: pg_isready -h <rds-endpoint> -p 5432',
  },
];
