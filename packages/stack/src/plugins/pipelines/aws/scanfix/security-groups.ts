/**
 * AWS Security Group Fixes
 *
 * Provisions security groups for EC2 and RDS.
 * EC2 SG: SSH(22), HTTP(80), HTTPS(443)
 * RDS SG: PostgreSQL(5432) from EC2 SG only
 * Uses AWS SDK v3.
 */

import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import {
  getAwsConfig,
  getProjectName,
  getResourceNames,
  isAwsConfigured,
  findVpc,
  findSecurityGroup,
  tagSpec,
  getEC2Client,
  confirmAwsAction,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  DescribeSecurityGroupsCommand,
} from '../utils/aws-helpers.js';

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
      const vpcId = await findVpc(projectName, region, config);
      if (!vpcId) return false;
      return !(await findSecurityGroup(getResourceNames(config).ec2SecurityGroup, vpcId, region));
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const vpcId = await findVpc(projectName, region, config);
      if (!vpcId) {
        console.log('   VPC must be created first');
        return false;
      }

      const groupName = getResourceNames(config).ec2SecurityGroup;
      const ok = await confirmAwsAction(
        'Create EC2 security group "' + groupName + '" in VPC ' + vpcId + ' (' + region + ')\n' +
        '  - Inbound: SSH(22), HTTP(80), HTTPS(443) from 0.0.0.0/0\n' +
        '  - Outbound: default (all)'
      );
      if (!ok) {
        console.log('   [--] Skipped — no EC2 security group created');
        return false;
      }

      try {
        const ec2 = getEC2Client(region);

        // Create security group
        const sgResult = await ec2.send(new CreateSecurityGroupCommand({
          GroupName: groupName,
          Description: 'EC2 security group for ' + projectName,
          VpcId: vpcId,
          TagSpecifications: [tagSpec('security-group', projectName)],
        }));
        const sgId = sgResult.GroupId;
        console.log('   Created EC2 security group: ' + sgId);

        // Allow SSH (port 22)
        await ec2.send(new AuthorizeSecurityGroupIngressCommand({
          GroupId: sgId,
          IpProtocol: 'tcp',
          FromPort: 22,
          ToPort: 22,
          CidrIp: '0.0.0.0/0',
        }));

        // Allow HTTP (port 80)
        await ec2.send(new AuthorizeSecurityGroupIngressCommand({
          GroupId: sgId,
          IpProtocol: 'tcp',
          FromPort: 80,
          ToPort: 80,
          CidrIp: '0.0.0.0/0',
        }));

        // Allow HTTPS (port 443)
        await ec2.send(new AuthorizeSecurityGroupIngressCommand({
          GroupId: sgId,
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          CidrIp: '0.0.0.0/0',
        }));

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
      const vpcId = await findVpc(projectName, region, config);
      if (!vpcId) return false;
      return !(await findSecurityGroup(getResourceNames(config).rdsSecurityGroup, vpcId, region));
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const vpcId = await findVpc(projectName, region, config);
      if (!vpcId) {
        console.log('   VPC must be created first');
        return false;
      }

      const ec2SgId = await findSecurityGroup(getResourceNames(config).ec2SecurityGroup, vpcId, region);
      if (!ec2SgId) {
        console.log('   EC2 security group must be created first');
        return false;
      }

      const groupName = getResourceNames(config).rdsSecurityGroup;
      const ok = await confirmAwsAction(
        'Create RDS security group "' + groupName + '" in VPC ' + vpcId + ' (' + region + ')\n' +
        '  - Inbound: PostgreSQL(5432) from EC2 SG ' + ec2SgId + ' only\n' +
        '  - Outbound: default (all)'
      );
      if (!ok) {
        console.log('   [--] Skipped — no RDS security group created');
        return false;
      }

      try {
        const ec2 = getEC2Client(region);

        // Create RDS security group
        const sgResult = await ec2.send(new CreateSecurityGroupCommand({
          GroupName: groupName,
          Description: 'RDS security group for ' + projectName,
          VpcId: vpcId,
          TagSpecifications: [tagSpec('security-group', projectName)],
        }));
        const sgId = sgResult.GroupId;
        console.log('   Created RDS security group: ' + sgId);

        // Allow PostgreSQL (port 5432) from EC2 security group ONLY
        await ec2.send(new AuthorizeSecurityGroupIngressCommand({
          GroupId: sgId,
          IpPermissions: [{
            IpProtocol: 'tcp',
            FromPort: 5432,
            ToPort: 5432,
            UserIdGroupPairs: [{ GroupId: ec2SgId }],
          }],
        }));

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
      const vpcId = await findVpc(projectName, region, config);
      if (!vpcId) return false;

      const rdsSgId = await findSecurityGroup(getResourceNames(config).rdsSecurityGroup, vpcId, region);
      if (!rdsSgId) return false;

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { extractEnvironments } = require('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);
      const stagingEnv = environments.staging;
      if (!stagingEnv?.domain) return false;
      // Skip if staging domain is still a placeholder
      if (stagingEnv.domain.toUpperCase().startsWith('EXAMPLE')) return false;

      // Resolve staging domain to IP (domain is a hostname, not an IP)
      let stagingIp = stagingEnv.domain;
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(stagingIp)) {
        try {
          const dns = await import('dns');
          const resolved = await new Promise<string[]>((resolve, reject) => {
            dns.resolve4(stagingIp, (err, addresses) => {
              if (err) reject(err);
              else resolve(addresses);
            });
          });
          if (resolved.length > 0 && resolved[0]) stagingIp = resolved[0];
          else return false;
        } catch {
          return false; // Cannot resolve staging domain
        }
      }

      // Check if RDS SG has an inbound rule for the staging IP
      try {
        const ec2 = getEC2Client(region);
        const rulesResult = await ec2.send(new DescribeSecurityGroupsCommand({
          GroupIds: [rdsSgId],
        }));
        const rules = rulesResult.SecurityGroups?.[0]?.IpPermissions ?? [];

        for (const rule of rules) {
          if (rule.FromPort === 5432 && rule.ToPort === 5432) {
            for (const ipRange of (rule.IpRanges ?? [])) {
              if (ipRange.CidrIp === stagingIp + '/32') {
                return false;
              }
            }
          }
        }
        return true;
      } catch {
        return false;
      }
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const vpcId = await findVpc(projectName, region, config);
      if (!vpcId) return false;

      const rdsSgId = await findSecurityGroup(getResourceNames(config).rdsSecurityGroup, vpcId, region);
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
      // Skip if staging domain is still a placeholder
      if (stagingEnv.domain.toUpperCase().startsWith('EXAMPLE')) {
        console.log('   Set staging domain in stack.yml first');
        return false;
      }

      try {
        const ec2 = getEC2Client(region);

        // Resolve hostname to IP
        let stagingIp = stagingEnv.domain;
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(stagingIp)) {
          try {
            const dns = await import('dns');
            const resolved = await new Promise<string[]>((resolve, reject) => {
              dns.resolve4(stagingIp, (err, addresses) => {
                if (err) reject(err);
                else resolve(addresses);
              });
            });
            if (resolved.length > 0 && resolved[0]) {
              stagingIp = resolved[0];
            } else {
              console.log('   Could not resolve staging domain: ' + stagingEnv.domain);
              return false;
            }
          } catch {
            console.log('   Could not resolve staging domain: ' + stagingEnv.domain);
            return false;
          }
        }

        const ok = await confirmAwsAction(
          'Add inbound rule to RDS SG ' + rdsSgId + '\n' +
          '  - PostgreSQL(5432) from ' + stagingIp + '/32 (' + stagingEnv.domain + ')'
        );
        if (!ok) {
          console.log('   [--] Skipped — RDS SG unchanged');
          return false;
        }

        await ec2.send(new AuthorizeSecurityGroupIngressCommand({
          GroupId: rdsSgId,
          IpProtocol: 'tcp',
          FromPort: 5432,
          ToPort: 5432,
          CidrIp: stagingIp + '/32',
        }));

        console.log('   Allowed staging (' + stagingEnv.domain + ' → ' + stagingIp + ') access to RDS on port 5432');
        return true;
      } catch (e) {
        console.log('   Failed to add Mac Mini access: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Add inbound rule to RDS security group for staging server IP on port 5432',
  },
];
