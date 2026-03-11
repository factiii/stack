/**
 * AWS VPC Fixes
 *
 * Provisions VPC, subnets, and internet gateway for AWS infrastructure.
 * All resources are tagged with factiii:project={name} for identification.
 * Uses AWS SDK v3 instead of CLI.
 */

import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import {
  getAwsConfig,
  getProjectName,
  isAwsConfigured,
  findVpc,
  findSubnet,
  findPrivateSubnets,
  findIgw,
  tagSpec,
  getEC2Client,
  CreateVpcCommand,
  ModifyVpcAttributeCommand,
  DescribeAvailabilityZonesCommand,
  CreateSubnetCommand,
  ModifySubnetAttributeCommand,
  CreateInternetGatewayCommand,
  AttachInternetGatewayCommand,
  CreateRouteTableCommand,
  CreateRouteCommand,
  AssociateRouteTableCommand,
} from '../utils/aws-helpers.js';

export const vpcFixes: Fix[] = [
  {
    id: 'aws-vpc-missing',
    stage: 'prod',
    severity: 'critical',
    description: '🌐 AWS VPC not created for this project',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      return !(await findVpc(projectName, region));
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);

      try {
        const ec2 = getEC2Client(region);

        // Create VPC
        const vpcResult = await ec2.send(new CreateVpcCommand({
          CidrBlock: '10.0.0.0/16',
          TagSpecifications: [tagSpec('vpc', projectName)],
        }));
        const vpcId = vpcResult.Vpc?.VpcId;
        console.log('   Created VPC: ' + vpcId);

        // Enable DNS hostnames
        await ec2.send(new ModifyVpcAttributeCommand({
          VpcId: vpcId,
          EnableDnsHostnames: { Value: true },
        }));

        // Enable DNS support
        await ec2.send(new ModifyVpcAttributeCommand({
          VpcId: vpcId,
          EnableDnsSupport: { Value: true },
        }));

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
    description: '🌐 Public subnet not created (for EC2)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      if (!(await findVpc(projectName, region))) return false;
      return !(await findSubnet(projectName, region, 'public'));
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const vpcId = await findVpc(projectName, region);
      if (!vpcId) {
        console.log('   VPC must be created first');
        return false;
      }

      try {
        const ec2 = getEC2Client(region);

        // Get first AZ
        const azResult = await ec2.send(new DescribeAvailabilityZonesCommand({}));
        const az = azResult.AvailabilityZones?.[0]?.ZoneName;
        if (!az) {
          console.log('   No availability zones found');
          return false;
        }

        // Create public subnet
        const subnetResult = await ec2.send(new CreateSubnetCommand({
          VpcId: vpcId,
          CidrBlock: '10.0.1.0/24',
          AvailabilityZone: az,
          TagSpecifications: [tagSpec('subnet', projectName, { 'factiii:subnet-type': 'public' })],
        }));
        const subnetId = subnetResult.Subnet?.SubnetId;

        // Enable auto-assign public IP
        await ec2.send(new ModifySubnetAttributeCommand({
          SubnetId: subnetId,
          MapPublicIpOnLaunch: { Value: true },
        }));

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
    description: '🌐 Private subnets not created (for RDS)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      if (!(await findVpc(projectName, region))) return false;
      const privateSubnets = await findPrivateSubnets(projectName, region);
      return privateSubnets.length < 2;
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const vpcId = await findVpc(projectName, region);
      if (!vpcId) {
        console.log('   VPC must be created first');
        return false;
      }

      try {
        const ec2 = getEC2Client(region);

        // Get first two AZs
        const azResult = await ec2.send(new DescribeAvailabilityZonesCommand({}));
        const azs = (azResult.AvailabilityZones ?? []).map(az => az.ZoneName!).filter(Boolean);
        if (azs.length < 2) {
          console.log('   Need at least 2 availability zones');
          return false;
        }

        // Create private subnet 1
        const sub1Result = await ec2.send(new CreateSubnetCommand({
          VpcId: vpcId,
          CidrBlock: '10.0.2.0/24',
          AvailabilityZone: azs[0],
          TagSpecifications: [tagSpec('subnet', projectName, { 'factiii:subnet-type': 'private' })],
        }));
        const sub1Id = sub1Result.Subnet?.SubnetId;
        console.log('   Created private subnet 1: ' + sub1Id + ' in ' + azs[0]);

        // Create private subnet 2
        const sub2Result = await ec2.send(new CreateSubnetCommand({
          VpcId: vpcId,
          CidrBlock: '10.0.3.0/24',
          AvailabilityZone: azs[1],
          TagSpecifications: [tagSpec('subnet', projectName, { 'factiii:subnet-type': 'private' })],
        }));
        const sub2Id = sub2Result.Subnet?.SubnetId;
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
    description: '🌐 Internet Gateway not attached to VPC',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const vpcId = await findVpc(projectName, region);
      if (!vpcId) return false;
      return !(await findIgw(vpcId, region));
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const vpcId = await findVpc(projectName, region);
      if (!vpcId) {
        console.log('   VPC must be created first');
        return false;
      }

      try {
        const ec2 = getEC2Client(region);

        // Create IGW
        const igwResult = await ec2.send(new CreateInternetGatewayCommand({
          TagSpecifications: [tagSpec('internet-gateway', projectName)],
        }));
        const igwId = igwResult.InternetGateway?.InternetGatewayId;
        console.log('   Created Internet Gateway: ' + igwId);

        // Attach to VPC
        await ec2.send(new AttachInternetGatewayCommand({
          InternetGatewayId: igwId,
          VpcId: vpcId,
        }));
        console.log('   Attached to VPC');

        // Create route table
        const rtResult = await ec2.send(new CreateRouteTableCommand({
          VpcId: vpcId,
          TagSpecifications: [tagSpec('route-table', projectName)],
        }));
        const rtId = rtResult.RouteTable?.RouteTableId;

        // Add route: 0.0.0.0/0 -> IGW
        await ec2.send(new CreateRouteCommand({
          RouteTableId: rtId,
          DestinationCidrBlock: '0.0.0.0/0',
          GatewayId: igwId,
        }));

        // Associate route table with public subnet
        const publicSubnetId = await findSubnet(projectName, region, 'public');
        if (publicSubnetId) {
          await ec2.send(new AssociateRouteTableCommand({
            RouteTableId: rtId,
            SubnetId: publicSubnetId,
          }));
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
