/**
 * AWS Security Group Fixes
 *
 * Provisions security groups for EC2 and RDS.
 * EC2 SG: SSH(22), HTTP(80), HTTPS(443)
 * RDS SG: PostgreSQL(5432) from EC2 SG only
 */

import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { awsExec, awsExecSafe, getAwsConfig, getProjectName, isOnServer, tagSpec } from '../utils/aws-helpers.js';

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
 * Find VPC by factiii:project tag (shared with vpc.ts)
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

export const securityGroupFixes: Fix[] = [
  {
    id: 'aws-sg-ec2-missing',
    stage: 'prod',
    severity: 'critical',
    description: '🛡️ EC2 security group not created (SSH, HTTP, HTTPS)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const vpcId = findVpc(projectName, region);
      if (!vpcId) return false; // VPC must exist first
      return !findSecurityGroup('factiii-' + projectName + '-ec2', vpcId, region);
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const vpcId = findVpc(projectName, region);
      if (!vpcId) {
        console.log('   VPC must be created first');
        return false;
      }

      try {
        const groupName = 'factiii-' + projectName + '-ec2';

        // Create security group
        const sgResult = awsExec(
          'aws ec2 create-security-group --group-name ' + groupName +
          ' --description "EC2 security group for ' + projectName + '"' +
          ' --vpc-id ' + vpcId +
          ' ' + tagSpec('security-group', projectName),
          region
        );
        const sgId = JSON.parse(sgResult).GroupId;
        console.log('   Created EC2 security group: ' + sgId);

        // Allow SSH (port 22)
        awsExec(
          'aws ec2 authorize-security-group-ingress --group-id ' + sgId +
          ' --protocol tcp --port 22 --cidr 0.0.0.0/0',
          region
        );

        // Allow HTTP (port 80)
        awsExec(
          'aws ec2 authorize-security-group-ingress --group-id ' + sgId +
          ' --protocol tcp --port 80 --cidr 0.0.0.0/0',
          region
        );

        // Allow HTTPS (port 443)
        awsExec(
          'aws ec2 authorize-security-group-ingress --group-id ' + sgId +
          ' --protocol tcp --port 443 --cidr 0.0.0.0/0',
          region
        );

        console.log('   Allowed inbound: SSH(22), HTTP(80), HTTPS(443)');
        return true;
      } catch (e) {
        console.log('   Failed to create EC2 security group: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Create EC2 security group with inbound rules for SSH(22), HTTP(80), HTTPS(443)',
  },
  {
    id: 'aws-sg-rds-missing',
    stage: 'prod',
    severity: 'critical',
    description: '🛡️ RDS security group not created (PostgreSQL from EC2 only)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const vpcId = findVpc(projectName, region);
      if (!vpcId) return false;
      return !findSecurityGroup('factiii-' + projectName + '-rds', vpcId, region);
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const vpcId = findVpc(projectName, region);
      if (!vpcId) {
        console.log('   VPC must be created first');
        return false;
      }

      // Need EC2 security group to reference
      const ec2SgId = findSecurityGroup('factiii-' + projectName + '-ec2', vpcId, region);
      if (!ec2SgId) {
        console.log('   EC2 security group must be created first');
        return false;
      }

      try {
        const groupName = 'factiii-' + projectName + '-rds';

        // Create RDS security group
        const sgResult = awsExec(
          'aws ec2 create-security-group --group-name ' + groupName +
          ' --description "RDS security group for ' + projectName + '"' +
          ' --vpc-id ' + vpcId +
          ' ' + tagSpec('security-group', projectName),
          region
        );
        const sgId = JSON.parse(sgResult).GroupId;
        console.log('   Created RDS security group: ' + sgId);

        // Allow PostgreSQL (port 5432) from EC2 security group ONLY
        awsExec(
          'aws ec2 authorize-security-group-ingress --group-id ' + sgId +
          ' --protocol tcp --port 5432 --source-group ' + ec2SgId,
          region
        );

        console.log('   Allowed inbound: PostgreSQL(5432) from EC2 SG only');
        return true;
      } catch (e) {
        console.log('   Failed to create RDS security group: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Create RDS security group allowing PostgreSQL(5432) from EC2 security group only',
  },
  {
    id: 'aws-sg-rds-mac-access',
    stage: 'prod',
    severity: 'info',
    description: '🛡️ RDS security group does not allow Mac Mini staging access',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const vpcId = findVpc(projectName, region);
      if (!vpcId) return false;

      const rdsSgId = findSecurityGroup('factiii-' + projectName + '-rds', vpcId, region);
      if (!rdsSgId) return false; // RDS SG must exist first

      // Check if staging domain is configured
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { extractEnvironments } = require('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);
      const stagingEnv = environments.staging;
      if (!stagingEnv?.domain) return false; // No staging configured

      // Check if RDS SG has an inbound rule for the staging IP
      const rulesResult = awsExecSafe(
        'aws ec2 describe-security-groups --group-ids ' + rdsSgId + ' --query "SecurityGroups[0].IpPermissions" --output json',
        region
      );
      if (!rulesResult) return false;

      try {
        const rules = JSON.parse(rulesResult);
        const stagingIp = stagingEnv.domain;
        // Check if any rule allows the staging IP on port 5432
        for (const rule of rules) {
          if (rule.FromPort === 5432 && rule.ToPort === 5432) {
            for (const ipRange of (rule.IpRanges || [])) {
              if (ipRange.CidrIp === stagingIp + '/32') {
                return false; // Already has access
              }
            }
          }
        }
        return true; // No rule found for staging IP
      } catch {
        return false;
      }
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const vpcId = findVpc(projectName, region);
      if (!vpcId) return false;

      const rdsSgId = findSecurityGroup('factiii-' + projectName + '-rds', vpcId, region);
      if (!rdsSgId) {
        console.log('   RDS security group must be created first');
        return false;
      }

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { extractEnvironments } = require('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);
      const stagingEnv = environments.staging;
      if (!stagingEnv?.domain) {
        console.log('   No staging domain configured');
        return false;
      }

      try {
        const stagingIp = stagingEnv.domain;

        // Add inbound rule for Mac Mini IP on PostgreSQL port
        awsExec(
          'aws ec2 authorize-security-group-ingress --group-id ' + rdsSgId +
          ' --protocol tcp --port 5432 --cidr ' + stagingIp + '/32',
          region
        );

        console.log('   Allowed Mac Mini (' + stagingIp + ') access to RDS on port 5432');
        return true;
      } catch (e) {
        console.log('   Failed to add Mac Mini access: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Add inbound rule to RDS security group for staging server IP on port 5432',
  },
];
