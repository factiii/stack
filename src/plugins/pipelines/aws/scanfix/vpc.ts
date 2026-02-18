/**
 * AWS VPC Fixes
 *
 * Provisions VPC, subnets, and internet gateway for AWS infrastructure.
 * All resources are tagged with factiii:project={name} for identification.
 */

import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { awsExec, awsExecSafe, getAwsConfig, getProjectName, tagSpec } from '../utils/aws-helpers.js';

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
 * Find subnet by tag and type
 */
function findSubnet(projectName: string, region: string, type: string): string | null {
  const result = awsExecSafe(
    'aws ec2 describe-subnets --filters "Name=tag:factiii:project,Values=' + projectName + '" "Name=tag:factiii:subnet-type,Values=' + type + '" --query "Subnets[0].SubnetId" --output text',
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
 * Find internet gateway attached to VPC
 */
function findIgw(vpcId: string, region: string): string | null {
  const result = awsExecSafe(
    'aws ec2 describe-internet-gateways --filters "Name=attachment.vpc-id,Values=' + vpcId + '" --query "InternetGateways[0].InternetGatewayId" --output text',
    region
  );
  if (!result || result === 'None' || result === 'null') return null;
  return result.replace(/"/g, '');
}

/**
 * Check if AWS is configured for this project (skip fixes if not)
 */
function isAwsConfigured(config: FactiiiConfig): boolean {
  if (config.aws) return true;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { extractEnvironments } = require('../../../../utils/config-helpers.js');
  const environments = extractEnvironments(config);
  return Object.values(environments).some(
    (e: unknown) => (e as { pipeline?: string }).pipeline === 'aws'
  );
}

export const vpcFixes: Fix[] = [
  {
    id: 'aws-vpc-missing',
    stage: 'prod',
    severity: 'critical',
    description: 'AWS VPC not created for this project',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      return !findVpc(projectName, region);
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);

      try {
        // Create VPC
        const vpcResult = awsExec(
          'aws ec2 create-vpc --cidr-block 10.0.0.0/16 ' + tagSpec('vpc', projectName),
          region
        );
        const vpcId = JSON.parse(vpcResult).Vpc.VpcId;
        console.log('   Created VPC: ' + vpcId);

        // Enable DNS hostnames
        awsExec(
          'aws ec2 modify-vpc-attribute --vpc-id ' + vpcId + ' --enable-dns-hostnames',
          region
        );

        // Enable DNS support
        awsExec(
          'aws ec2 modify-vpc-attribute --vpc-id ' + vpcId + ' --enable-dns-support',
          region
        );

        console.log('   Enabled DNS hostnames and support');
        return true;
      } catch (e) {
        console.log('   Failed to create VPC: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Create VPC: aws ec2 create-vpc --cidr-block 10.0.0.0/16',
  },
  {
    id: 'aws-subnet-public-missing',
    stage: 'prod',
    severity: 'critical',
    description: 'Public subnet not created (for EC2)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      if (!findVpc(projectName, region)) return false; // VPC must exist first
      return !findSubnet(projectName, region, 'public');
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
        // Get first AZ
        const azResult = awsExec(
          'aws ec2 describe-availability-zones --query "AvailabilityZones[0].ZoneName" --output text',
          region
        );
        const az = azResult.replace(/"/g, '');

        // Create public subnet
        const subnetResult = awsExec(
          'aws ec2 create-subnet --vpc-id ' + vpcId + ' --cidr-block 10.0.1.0/24 --availability-zone ' + az + ' ' +
          tagSpec('subnet', projectName, { 'factiii:subnet-type': 'public' }),
          region
        );
        const subnetId = JSON.parse(subnetResult).Subnet.SubnetId;

        // Enable auto-assign public IP
        awsExec(
          'aws ec2 modify-subnet-attribute --subnet-id ' + subnetId + ' --map-public-ip-on-launch',
          region
        );

        console.log('   Created public subnet: ' + subnetId + ' in ' + az);
        return true;
      } catch (e) {
        console.log('   Failed to create public subnet: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Create public subnet in VPC with auto-assign public IP',
  },
  {
    id: 'aws-subnet-private-missing',
    stage: 'prod',
    severity: 'critical',
    description: 'Private subnets not created (for RDS)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      if (!findVpc(projectName, region)) return false;
      const privateSubnets = findPrivateSubnets(projectName, region);
      return privateSubnets.length < 2; // RDS needs at least 2 AZs
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
        // Get first two AZs
        const azResult = awsExec(
          'aws ec2 describe-availability-zones --query "AvailabilityZones[*].ZoneName" --output text',
          region
        );
        const azs = azResult.split(/\s+/).filter(Boolean);
        if (azs.length < 2) {
          console.log('   Need at least 2 availability zones');
          return false;
        }

        // Create private subnet 1 (10.0.2.0/24)
        const sub1Result = awsExec(
          'aws ec2 create-subnet --vpc-id ' + vpcId + ' --cidr-block 10.0.2.0/24 --availability-zone ' + azs[0] + ' ' +
          tagSpec('subnet', projectName, { 'factiii:subnet-type': 'private' }),
          region
        );
        const sub1Id = JSON.parse(sub1Result).Subnet.SubnetId;
        console.log('   Created private subnet 1: ' + sub1Id + ' in ' + azs[0]);

        // Create private subnet 2 (10.0.3.0/24)
        const sub2Result = awsExec(
          'aws ec2 create-subnet --vpc-id ' + vpcId + ' --cidr-block 10.0.3.0/24 --availability-zone ' + azs[1] + ' ' +
          tagSpec('subnet', projectName, { 'factiii:subnet-type': 'private' }),
          region
        );
        const sub2Id = JSON.parse(sub2Result).Subnet.SubnetId;
        console.log('   Created private subnet 2: ' + sub2Id + ' in ' + azs[1]);

        return true;
      } catch (e) {
        console.log('   Failed to create private subnets: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Create 2 private subnets in different AZs for RDS subnet group',
  },
  {
    id: 'aws-igw-missing',
    stage: 'prod',
    severity: 'critical',
    description: 'Internet Gateway not attached to VPC',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const vpcId = findVpc(projectName, region);
      if (!vpcId) return false;
      return !findIgw(vpcId, region);
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
        // Create IGW
        const igwResult = awsExec(
          'aws ec2 create-internet-gateway ' + tagSpec('internet-gateway', projectName),
          region
        );
        const igwId = JSON.parse(igwResult).InternetGateway.InternetGatewayId;
        console.log('   Created Internet Gateway: ' + igwId);

        // Attach to VPC
        awsExec(
          'aws ec2 attach-internet-gateway --internet-gateway-id ' + igwId + ' --vpc-id ' + vpcId,
          region
        );
        console.log('   Attached to VPC');

        // Create route table and add default route
        const rtResult = awsExec(
          'aws ec2 create-route-table --vpc-id ' + vpcId + ' ' + tagSpec('route-table', projectName),
          region
        );
        const rtId = JSON.parse(rtResult).RouteTable.RouteTableId;

        // Add route: 0.0.0.0/0 -> IGW
        awsExec(
          'aws ec2 create-route --route-table-id ' + rtId + ' --destination-cidr-block 0.0.0.0/0 --gateway-id ' + igwId,
          region
        );

        // Associate route table with public subnet
        const publicSubnetId = findSubnet(projectName, region, 'public');
        if (publicSubnetId) {
          awsExec(
            'aws ec2 associate-route-table --route-table-id ' + rtId + ' --subnet-id ' + publicSubnetId,
            region
          );
          console.log('   Associated route table with public subnet');
        }

        return true;
      } catch (e) {
        console.log('   Failed to create IGW: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Create Internet Gateway, attach to VPC, add default route to public subnet',
  },
];
