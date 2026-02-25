/**
 * AWS EC2 Fixes
 *
 * Provisions EC2 key pair, instance, and Elastic IP.
 * Uses Ubuntu 22.04 AMI, t3.micro (free tier), public subnet.
 * Key pair private key is stored in Ansible Vault.
 * Uses AWS SDK v3.
 */

import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import {
  getAwsConfig,
  getProjectName,
  isAwsConfigured,
  findVpc,
  findSubnet,
  findSecurityGroup,
  findKeyPair,
  findInstance,
  findElasticIp,
  tagSpec,
  getEC2Client,
  CreateKeyPairCommand,
  DescribeImagesCommand,
  RunInstancesCommand,
  waitUntilInstanceRunning,
  DescribeInstancesCommand,
  AllocateAddressCommand,
  AssociateAddressCommand,
} from '../utils/aws-helpers.js';

export const ec2Fixes: Fix[] = [
  {
    id: 'aws-keypair-missing',
    stage: 'prod',
    severity: 'critical',
    description: '🖥️ EC2 key pair not created for SSH access',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      return !(await findKeyPair('factiii-' + projectName, region));
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const keyName = 'factiii-' + projectName;

      try {
        const ec2 = getEC2Client(region);

        // Create key pair — AWS returns the private key material
        const result = await ec2.send(new CreateKeyPairCommand({
          KeyName: keyName,
          KeyType: 'ed25519',
        }));
        const privateKey = result.KeyMaterial;

        // Save private key to ~/.ssh/prod_deploy_key
        const os = await import('os');
        const fs = await import('fs');
        const path = await import('path');
        const sshDir = path.join(os.homedir(), '.ssh');
        if (!fs.existsSync(sshDir)) {
          fs.mkdirSync(sshDir, { mode: 0o700 });
        }
        const keyPath = path.join(sshDir, 'prod_deploy_key');
        fs.writeFileSync(keyPath, privateKey + '\n', { mode: 0o600 });
        console.log('   Created key pair: ' + keyName);
        console.log('   Private key saved to: ' + keyPath);

        if (config.ansible?.vault_path) {
          console.log('   TIP: Add this key to Ansible Vault with: npx stack secrets edit');
        }

        return true;
      } catch (e) {
        console.log('   Failed to create key pair: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Create key pair: aws ec2 create-key-pair --key-name factiii-{name} --key-type ed25519',
  },
  {
    id: 'aws-ec2-instance-missing',
    stage: 'prod',
    severity: 'critical',
    description: '🖥️ EC2 instance not created (Ubuntu 22.04, t3.micro)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      return !(await findInstance(projectName, region));
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const vpcId = await findVpc(projectName, region);
      if (!vpcId) {
        console.log('   VPC must be created first');
        return false;
      }

      const publicSubnet = await findSubnet(projectName, region, 'public');
      if (!publicSubnet) {
        console.log('   Public subnet must be created first');
        return false;
      }

      const ec2SgId = await findSecurityGroup('factiii-' + projectName + '-ec2', vpcId, region);
      if (!ec2SgId) {
        console.log('   EC2 security group must be created first');
        return false;
      }

      const keyName = 'factiii-' + projectName;
      if (!(await findKeyPair(keyName, region))) {
        console.log('   Key pair must be created first');
        return false;
      }

      try {
        const ec2 = getEC2Client(region);

        // Get latest Ubuntu 22.04 AMI
        const amiResult = await ec2.send(new DescribeImagesCommand({
          Owners: ['099720109477'],
          Filters: [
            { Name: 'name', Values: ['ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*'] },
            { Name: 'state', Values: ['available'] },
          ],
        }));
        const images = (amiResult.Images ?? []).sort((a, b) =>
          (b.CreationDate ?? '').localeCompare(a.CreationDate ?? '')
        );
        const amiId = images[0]?.ImageId;
        if (!amiId) {
          console.log('   Failed to find Ubuntu 22.04 AMI for region ' + region);
          return false;
        }
        console.log('   Using AMI: ' + amiId);

        // Launch instance
        const instanceResult = await ec2.send(new RunInstancesCommand({
          ImageId: amiId,
          InstanceType: 't3.micro',
          KeyName: keyName,
          SecurityGroupIds: [ec2SgId],
          SubnetId: publicSubnet,
          MinCount: 1,
          MaxCount: 1,
          TagSpecifications: [tagSpec('instance', projectName)],
        }));
        const instanceId = instanceResult.Instances?.[0]?.InstanceId;
        console.log('   Launched EC2 instance: ' + instanceId);
        console.log('   Instance type: t3.micro (free tier eligible)');
        console.log('   Waiting for instance to be running...');

        // Wait for instance to be running
        await waitUntilInstanceRunning(
          { client: ec2, maxWaitTime: 300 },
          { InstanceIds: [instanceId!] }
        );

        // Get public IP
        const descResult = await ec2.send(new DescribeInstancesCommand({
          InstanceIds: [instanceId!],
        }));
        const publicIp = descResult.Reservations?.[0]?.Instances?.[0]?.PublicIpAddress;
        if (publicIp) {
          console.log('   Public IP: ' + publicIp);
          console.log('   NOTE: This IP will change on restart. Run fix again for Elastic IP.');
        }

        return true;
      } catch (e) {
        console.log('   Failed to launch EC2 instance: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Launch EC2: aws ec2 run-instances --image-id <ubuntu-ami> --instance-type t3.micro --key-name factiii-{name}',
  },
  {
    id: 'aws-ec2-elastic-ip',
    stage: 'prod',
    severity: 'warning',
    description: '🖥️ Elastic IP not assigned to EC2 instance (IP changes on restart)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const instanceId = await findInstance(projectName, region);
      if (!instanceId) return false;
      return !(await findElasticIp(instanceId, region));
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const instanceId = await findInstance(projectName, region);
      if (!instanceId) {
        console.log('   EC2 instance must be created first');
        return false;
      }

      try {
        const ec2 = getEC2Client(region);

        // Allocate Elastic IP
        const eipResult = await ec2.send(new AllocateAddressCommand({
          Domain: 'vpc',
          TagSpecifications: [tagSpec('elastic-ip', projectName)],
        }));
        const allocationId = eipResult.AllocationId;
        const publicIp = eipResult.PublicIp;
        console.log('   Allocated Elastic IP: ' + publicIp);

        // Associate with instance
        await ec2.send(new AssociateAddressCommand({
          AllocationId: allocationId,
          InstanceId: instanceId,
        }));
        console.log('   Associated with instance: ' + instanceId);

        // Auto-update stack.yml
        const { updateConfigValue } = await import('../../../../utils/config-writer.js');
        const dir = rootDir || process.cwd();
        updateConfigValue(dir, 'prod.domain', publicIp!);
        updateConfigValue(dir, 'prod.ssh_user', 'ubuntu');

        return true;
      } catch (e) {
        console.log('   Failed to allocate Elastic IP: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Allocate Elastic IP and associate with EC2 instance',
  },
];
