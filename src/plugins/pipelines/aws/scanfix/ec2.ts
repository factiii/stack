/**
 * AWS EC2 Fixes
 *
 * Provisions EC2 key pair, instance, and Elastic IP.
 * Uses Ubuntu 22.04 AMI, t3.micro (free tier), public subnet.
 * Key pair private key is stored in Ansible Vault.
 */

import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { awsExec, awsExecSafe, getAwsConfig, getProjectName, isOnServer, tagSpec } from '../utils/aws-helpers.js';

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
 * Find EC2 key pair by name
 */
function findKeyPair(keyName: string, region: string): boolean {
  const result = awsExecSafe(
    'aws ec2 describe-key-pairs --key-names ' + keyName + ' --query "KeyPairs[0].KeyPairId" --output text',
    region
  );
  return !!result && result !== 'None' && result !== 'null';
}

/**
 * Find running EC2 instance by tag
 */
function findInstance(projectName: string, region: string): string | null {
  const result = awsExecSafe(
    'aws ec2 describe-instances --filters "Name=tag:factiii:project,Values=' + projectName + '" "Name=instance-state-name,Values=running,stopped" --query "Reservations[0].Instances[0].InstanceId" --output text',
    region
  );
  if (!result || result === 'None' || result === 'null') return null;
  return result.replace(/"/g, '');
}

/**
 * Find Elastic IP associated with an instance
 */
function findElasticIp(instanceId: string, region: string): string | null {
  const result = awsExecSafe(
    'aws ec2 describe-addresses --filters "Name=instance-id,Values=' + instanceId + '" --query "Addresses[0].PublicIp" --output text',
    region
  );
  if (!result || result === 'None' || result === 'null') return null;
  return result.replace(/"/g, '');
}

/**
 * Get latest Ubuntu 22.04 AMI for the region
 */
function getUbuntuAmi(region: string): string | null {
  const result = awsExecSafe(
    'aws ec2 describe-images --owners 099720109477 --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" "Name=state,Values=available" --query "sort_by(Images, &CreationDate)[-1].ImageId" --output text',
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

export const ec2Fixes: Fix[] = [
  {
    id: 'aws-keypair-missing',
    stage: 'prod',
    severity: 'critical',
    description: 'EC2 key pair not created for SSH access',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      return !findKeyPair('factiii-' + projectName, region);
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const keyName = 'factiii-' + projectName;

      try {
        // Create key pair — AWS returns the private key material
        const result = awsExec(
          'aws ec2 create-key-pair --key-name ' + keyName + ' --key-type ed25519 --query "KeyMaterial" --output text',
          region
        );

        // Save private key to ~/.ssh/prod_deploy_key
        const os = await import('os');
        const fs = await import('fs');
        const path = await import('path');
        const sshDir = path.join(os.homedir(), '.ssh');
        if (!fs.existsSync(sshDir)) {
          fs.mkdirSync(sshDir, { mode: 0o700 });
        }
        const keyPath = path.join(sshDir, 'prod_deploy_key');
        fs.writeFileSync(keyPath, result + '\n', { mode: 0o600 });
        console.log('   Created key pair: ' + keyName);
        console.log('   Private key saved to: ' + keyPath);

        // Store in Ansible Vault if configured
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
    description: 'EC2 instance not created (Ubuntu 22.04, t3.micro)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      return !findInstance(projectName, region);
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const vpcId = findVpc(projectName, region);
      if (!vpcId) {
        console.log('   VPC must be created first');
        return false;
      }

      const publicSubnet = findSubnet(projectName, region, 'public');
      if (!publicSubnet) {
        console.log('   Public subnet must be created first');
        return false;
      }

      const ec2SgId = findSecurityGroup('factiii-' + projectName + '-ec2', vpcId, region);
      if (!ec2SgId) {
        console.log('   EC2 security group must be created first');
        return false;
      }

      const keyName = 'factiii-' + projectName;
      if (!findKeyPair(keyName, region)) {
        console.log('   Key pair must be created first');
        return false;
      }

      try {
        // Get latest Ubuntu 22.04 AMI
        const amiId = getUbuntuAmi(region);
        if (!amiId) {
          console.log('   Failed to find Ubuntu 22.04 AMI for region ' + region);
          return false;
        }
        console.log('   Using AMI: ' + amiId);

        // Launch instance
        const instanceResult = awsExec(
          'aws ec2 run-instances' +
          ' --image-id ' + amiId +
          ' --instance-type t3.micro' +
          ' --key-name ' + keyName +
          ' --security-group-ids ' + ec2SgId +
          ' --subnet-id ' + publicSubnet +
          ' --count 1' +
          ' ' + tagSpec('instance', projectName),
          region
        );
        const instanceId = JSON.parse(instanceResult).Instances[0].InstanceId;
        console.log('   Launched EC2 instance: ' + instanceId);
        console.log('   Instance type: t3.micro (free tier eligible)');
        console.log('   Waiting for instance to be running...');

        // Wait for instance to be running
        awsExec(
          'aws ec2 wait instance-running --instance-ids ' + instanceId,
          region
        );

        // Get public IP
        const ipResult = awsExecSafe(
          'aws ec2 describe-instances --instance-ids ' + instanceId + ' --query "Reservations[0].Instances[0].PublicIpAddress" --output text',
          region
        );
        if (ipResult && ipResult !== 'None') {
          console.log('   Public IP: ' + ipResult.replace(/"/g, ''));
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
    description: 'Elastic IP not assigned to EC2 instance (IP changes on restart)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const instanceId = findInstance(projectName, region);
      if (!instanceId) return false; // Instance must exist first
      return !findElasticIp(instanceId, region);
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const projectName = getProjectName(config);
      const instanceId = findInstance(projectName, region);
      if (!instanceId) {
        console.log('   EC2 instance must be created first');
        return false;
      }

      try {
        // Allocate Elastic IP
        const eipResult = awsExec(
          'aws ec2 allocate-address --domain vpc ' + tagSpec('elastic-ip', projectName),
          region
        );
        const parsed = JSON.parse(eipResult);
        const allocationId = parsed.AllocationId;
        const publicIp = parsed.PublicIp;
        console.log('   Allocated Elastic IP: ' + publicIp);

        // Associate with instance
        awsExec(
          'aws ec2 associate-address --allocation-id ' + allocationId + ' --instance-id ' + instanceId,
          region
        );
        console.log('   Associated with instance: ' + instanceId);

        // Auto-update stack.yml with the new Elastic IP
        const { updateConfigValue } = await import('../../../../utils/config-writer.js');
        const dir = rootDir || process.cwd();
        updateConfigValue(dir, 'prod.domain', publicIp);
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
