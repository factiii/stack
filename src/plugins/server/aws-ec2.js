/**
 * AWS EC2 Server Provider Plugin
 * 
 * Deploys containers to AWS EC2 instances.
 * Supports both manual setup and auto-provisioning.
 * Typically used for production environments.
 */
const ServerProvider = require('../interfaces/server-provider');

class AWSEC2Provider extends ServerProvider {
  // ============================================================
  // STATIC METADATA
  // ============================================================
  
  static id = 'aws-ec2';
  static name = 'AWS EC2';
  static category = 'server';
  static version = '1.0.0';
  
  // Simplified secrets - only SSH key and AWS_SECRET_ACCESS_KEY are secrets
  // HOST is in factiii.yml, USER defaults to ubuntu in factiiiAuto.yml
  // AWS_ACCESS_KEY_ID and AWS_REGION are in factiii.yml (not sensitive)
  static requiredSecrets = [
    { 
      name: 'SSH', 
      type: 'ssh_key', 
      description: 'SSH private key for accessing EC2 instance',
      autoGenerate: true  // Can be auto-generated via AWS API
    },
    {
      name: 'AWS_SECRET_ACCESS_KEY',
      type: 'aws_secret',
      description: 'AWS Secret Access Key',
      shared: true
    }
  ];
  
  static helpText = {
    SSH: `
   SSH private key for accessing the EC2 instance.
   
   Option A: Auto-generate via AWS (recommended)
   - Factiii will create an EC2 Key Pair via AWS API
   - The private key will be saved and uploaded to GitHub
   
   Option B: Use existing key
   
   Step 1: Generate a new SSH key pair:
   ssh-keygen -t ed25519 -C "deploy-key" -f ~/.ssh/deploy_key
   
   Step 2: Add PUBLIC key to EC2 instance:
   ssh-copy-id -i ~/.ssh/deploy_key.pub ubuntu@YOUR_HOST
   
   Step 3: Paste the PRIVATE key below (multi-line, end with blank line):
   cat ~/.ssh/deploy_key`,
    
    AWS_SECRET_ACCESS_KEY: `
   AWS Secret Access Key
   
   Get from AWS Console: IAM → Users → Security credentials
   
   This is shown only once when you create the key.
   If lost, you must create a new key pair.
   
   Note: AWS_ACCESS_KEY_ID and AWS_REGION go in factiii.yml (not secrets)
   
   Enter AWS Secret Access Key:`
  };
  
  static capabilities = {
    autoProvision: true,   // Can create EC2 instances
    autoSSHKey: true,      // Can generate key pairs via AWS
    elasticIP: true,       // Can assign Elastic IPs
    autoScaling: false     // Not yet implemented
  };
  
  // Default instance settings
  static defaults = {
    instanceType: 't3.small',
    volumeSize: 20,        // GB
    amiFilter: 'ubuntu/images/hvm-ssd/ubuntu-*-22.04-amd64-server-*',
    amiOwner: '099720109477'  // Canonical
  };
  
  // ============================================================
  // REQUIRED METHODS
  // ============================================================
  
  /**
   * Initial server setup
   */
  async setup(envConfig) {
    const result = { success: false, message: '', error: null };
    
    // If auto-provision is requested
    if (envConfig.autoProvision) {
      const provision = await this._provisionInstance(envConfig);
      if (!provision.success) {
        result.error = provision.error;
        return result;
      }
      
      // Update secrets with new instance details
      this.secrets.HOST = provision.publicIp;
      result.message = `Provisioned new EC2 instance: ${provision.instanceId}`;
    }
    
    // Test SSH connection
    const connTest = await this.testConnection();
    if (!connTest.success) {
      result.error = `SSH connection failed: ${connTest.error}`;
      return result;
    }
    
    // Check/install prerequisites
    const prereqs = await this._checkPrerequisites();
    if (!prereqs.success) {
      result.error = prereqs.error;
      return result;
    }
    
    // Create infrastructure directory
    const infraDir = await this._setupInfrastructureDir();
    if (!infraDir.success) {
      result.error = infraDir.error;
      return result;
    }
    
    result.success = true;
    result.message = result.message || 'EC2 setup complete';
    return result;
  }
  
  /**
   * Deploy a container to EC2
   */
  async deploy(image, envConfig) {
    const result = { 
      success: false, 
      containerId: null, 
      message: '', 
      error: null 
    };
    
    const serviceName = `${envConfig.name || 'app'}-${envConfig.environment || 'production'}`;
    const port = envConfig.port || 3000;
    
    try {
      // Login to ECR
      if (image.includes('.ecr.')) {
        const ecrLogin = await this._ecrLogin(image);
        if (!ecrLogin.success) {
          result.error = `ECR login failed: ${ecrLogin.error}`;
          return result;
        }
      }
      
      // Pull the image
      const pullResult = await this.executeCommand(`docker pull ${image}`);
      if (!pullResult.success) {
        result.error = `Failed to pull image: ${pullResult.error}`;
        return result;
      }
      
      // Stop existing container if running
      await this.executeCommand(`docker stop ${serviceName} 2>/dev/null || true`);
      await this.executeCommand(`docker rm ${serviceName} 2>/dev/null || true`);
      
      // Start new container
      const envFile = envConfig.envFile || `~/.factiii/envs/${serviceName}.env`;
      const runCommand = [
        'docker run -d',
        `--name ${serviceName}`,
        `-p ${port}:${port}`,
        `--env-file ${envFile}`,
        '--restart unless-stopped',
        image
      ].join(' ');
      
      const runResult = await this.executeCommand(runCommand);
      if (!runResult.success) {
        result.error = `Failed to start container: ${runResult.error}`;
        return result;
      }
      
      result.containerId = runResult.output.trim();
      
      // Wait for container to be healthy
      const healthResult = await this._waitForHealth(serviceName, envConfig);
      if (!healthResult.healthy) {
        result.error = `Container started but health check failed: ${healthResult.error}`;
      }
      
      result.success = true;
      result.message = `Deployed ${serviceName} on port ${port}`;
      
    } catch (error) {
      result.error = error.message;
    }
    
    return result;
  }
  
  /**
   * Check if server is reachable and healthy
   */
  async healthCheck(envConfig) {
    const result = { healthy: false, details: {}, error: null };
    
    // Test SSH connection
    const sshTest = await this.testConnection();
    result.details.ssh = sshTest.success;
    
    if (!sshTest.success) {
      result.error = sshTest.error;
      return result;
    }
    
    // Check Docker is running
    const dockerTest = await this.executeCommand('docker info > /dev/null 2>&1 && echo "running"');
    result.details.docker = dockerTest.success && dockerTest.output?.includes('running');
    
    if (!result.details.docker) {
      result.error = 'Docker is not running on EC2 instance';
      return result;
    }
    
    // Check container status if envConfig provided
    if (envConfig?.name) {
      const serviceName = `${envConfig.name}-${envConfig.environment || 'production'}`;
      const containerCheck = await this.executeCommand(`docker inspect ${serviceName} --format '{{.State.Status}}'`);
      result.details.container = containerCheck.output?.trim();
      result.details.containerRunning = result.details.container === 'running';
    }
    
    result.healthy = result.details.docker && (result.details.containerRunning !== false);
    return result;
  }
  
  /**
   * Get current deployment status
   */
  async getStatus(envConfig) {
    const result = { 
      deployed: false, 
      container: null, 
      uptime: null, 
      error: null 
    };
    
    const serviceName = `${envConfig.name || 'app'}-${envConfig.environment || 'production'}`;
    
    try {
      const inspectResult = await this.executeCommand(
        `docker inspect ${serviceName} --format '{{json .}}'`
      );
      
      if (!inspectResult.success) {
        return result;
      }
      
      const containerInfo = JSON.parse(inspectResult.output);
      
      result.deployed = true;
      result.container = {
        id: containerInfo.Id?.substring(0, 12),
        name: containerInfo.Name?.replace(/^\//, ''),
        image: containerInfo.Config?.Image,
        status: containerInfo.State?.Status,
        running: containerInfo.State?.Running,
        startedAt: containerInfo.State?.StartedAt
      };
      
      if (containerInfo.State?.StartedAt) {
        const started = new Date(containerInfo.State.StartedAt);
        const now = new Date();
        const uptimeMs = now - started;
        const uptimeHours = Math.floor(uptimeMs / (1000 * 60 * 60));
        const uptimeMins = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
        result.uptime = `${uptimeHours}h ${uptimeMins}m`;
      }
      
    } catch (error) {
      result.error = error.message;
    }
    
    return result;
  }
  
  /**
   * Remove deployment from server
   */
  async teardown(envConfig) {
    const result = { success: false, message: '', error: null };
    
    const serviceName = `${envConfig.name || 'app'}-${envConfig.environment || 'production'}`;
    
    try {
      await this.executeCommand(`docker stop ${serviceName} 2>/dev/null || true`);
      await this.executeCommand(`docker rm ${serviceName} 2>/dev/null || true`);
      await this.executeCommand(
        `rm -f ~/.factiii/configs/${envConfig.name}.yml 2>/dev/null || true`
      );
      await this.executeCommand(
        `rm -f ~/.factiii/envs/${serviceName}.env 2>/dev/null || true`
      );
      
      result.success = true;
      result.message = `Removed ${serviceName} from EC2`;
      
    } catch (error) {
      result.error = error.message;
    }
    
    return result;
  }
  
  // ============================================================
  // EC2-SPECIFIC METHODS
  // ============================================================
  
  /**
   * Provision a new EC2 instance via AWS API
   */
  async _provisionInstance(envConfig) {
    const { execSync } = require('child_process');
    const result = { 
      success: false, 
      instanceId: null, 
      publicIp: null, 
      keyPair: null,
      error: null 
    };
    
    const region = this.secrets.AWS_REGION || envConfig.region || 'us-east-1';
    const instanceType = envConfig.instanceType || AWSEC2Provider.defaults.instanceType;
    const keyName = `${envConfig.name || 'factiii'}-${envConfig.environment || 'prod'}-${Date.now()}`;
    
    try {
      // Step 1: Create EC2 Key Pair
      console.log('   Creating EC2 key pair...');
      const keyPairOutput = execSync(
        `aws ec2 create-key-pair --key-name ${keyName} --query 'KeyMaterial' --output text --region ${region}`,
        { encoding: 'utf8', stdio: 'pipe', env: this._getAWSEnv() }
      );
      result.keyPair = {
        name: keyName,
        privateKey: keyPairOutput.trim()
      };
      
      // Step 2: Get latest Ubuntu AMI
      console.log('   Finding latest Ubuntu AMI...');
      const amiId = execSync(
        `aws ec2 describe-images ` +
        `--owners ${AWSEC2Provider.defaults.amiOwner} ` +
        `--filters "Name=name,Values=${AWSEC2Provider.defaults.amiFilter}" ` +
        `--query 'sort_by(Images, &CreationDate)[-1].ImageId' ` +
        `--output text --region ${region}`,
        { encoding: 'utf8', stdio: 'pipe', env: this._getAWSEnv() }
      ).trim();
      
      // Step 3: Get or create security group
      console.log('   Configuring security group...');
      const sgId = await this._getOrCreateSecurityGroup(region, envConfig);
      
      // Step 4: Launch instance
      console.log('   Launching EC2 instance...');
      const launchOutput = execSync(
        `aws ec2 run-instances ` +
        `--image-id ${amiId} ` +
        `--instance-type ${instanceType} ` +
        `--key-name ${keyName} ` +
        `--security-group-ids ${sgId} ` +
        `--tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=${envConfig.name || 'factiii'}-${envConfig.environment || 'prod'}},{Key=Environment,Value=${envConfig.environment || 'prod'}},{Key=ManagedBy,Value=factiii}]' ` +
        `--block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":${AWSEC2Provider.defaults.volumeSize}}}]' ` +
        `--output json --region ${region}`,
        { encoding: 'utf8', stdio: 'pipe', env: this._getAWSEnv() }
      );
      
      const launchResult = JSON.parse(launchOutput);
      result.instanceId = launchResult.Instances[0].InstanceId;
      
      // Step 5: Wait for instance to be running
      console.log('   Waiting for instance to start...');
      execSync(
        `aws ec2 wait instance-running --instance-ids ${result.instanceId} --region ${region}`,
        { stdio: 'pipe', env: this._getAWSEnv() }
      );
      
      // Step 6: Get public IP
      const ipOutput = execSync(
        `aws ec2 describe-instances ` +
        `--instance-ids ${result.instanceId} ` +
        `--query 'Reservations[0].Instances[0].PublicIpAddress' ` +
        `--output text --region ${region}`,
        { encoding: 'utf8', stdio: 'pipe', env: this._getAWSEnv() }
      );
      result.publicIp = ipOutput.trim();
      
      // Step 7: Wait for SSH to be ready
      console.log('   Waiting for SSH to be ready...');
      await this._waitForSSH(result.publicIp, result.keyPair.privateKey);
      
      // Step 8: Install Docker
      console.log('   Installing Docker...');
      await this._installDocker(result.publicIp, result.keyPair.privateKey);
      
      result.success = true;
      
    } catch (error) {
      result.error = `Failed to provision EC2: ${error.message}`;
      
      // Cleanup on failure
      if (result.keyPair?.name) {
        try {
          execSync(
            `aws ec2 delete-key-pair --key-name ${result.keyPair.name} --region ${region}`,
            { stdio: 'pipe', env: this._getAWSEnv() }
          );
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    }
    
    return result;
  }
  
  /**
   * Get or create security group for the instance
   * @private
   */
  async _getOrCreateSecurityGroup(region, envConfig) {
    const { execSync } = require('child_process');
    const sgName = `factiii-${envConfig.environment || 'prod'}-sg`;
    
    try {
      // Check if security group exists
      const existingOutput = execSync(
        `aws ec2 describe-security-groups ` +
        `--filters "Name=group-name,Values=${sgName}" ` +
        `--query 'SecurityGroups[0].GroupId' ` +
        `--output text --region ${region}`,
        { encoding: 'utf8', stdio: 'pipe', env: this._getAWSEnv() }
      ).trim();
      
      if (existingOutput && existingOutput !== 'None') {
        return existingOutput;
      }
    } catch (e) {
      // Security group doesn't exist
    }
    
    // Create security group
    const createOutput = execSync(
      `aws ec2 create-security-group ` +
      `--group-name ${sgName} ` +
      `--description "Security group for Factiii managed instances" ` +
      `--output text --region ${region}`,
      { encoding: 'utf8', stdio: 'pipe', env: this._getAWSEnv() }
    ).trim();
    
    const sgId = createOutput;
    
    // Add inbound rules
    const rules = [
      { port: 22, description: 'SSH' },
      { port: 80, description: 'HTTP' },
      { port: 443, description: 'HTTPS' },
      { port: 3000, description: 'App default port' }
    ];
    
    for (const rule of rules) {
      try {
        execSync(
          `aws ec2 authorize-security-group-ingress ` +
          `--group-id ${sgId} ` +
          `--protocol tcp ` +
          `--port ${rule.port} ` +
          `--cidr 0.0.0.0/0 ` +
          `--region ${region}`,
          { stdio: 'pipe', env: this._getAWSEnv() }
        );
      } catch (e) {
        // Rule might already exist
      }
    }
    
    return sgId;
  }
  
  /**
   * Wait for SSH to be available
   * @private
   */
  async _waitForSSH(host, privateKey, maxWaitSeconds = 120) {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const { execSync } = require('child_process');
    
    const tempKeyPath = path.join(os.tmpdir(), `core_ssh_${Date.now()}`);
    fs.writeFileSync(tempKeyPath, privateKey, { mode: 0o600 });
    
    const startTime = Date.now();
    
    try {
      while (Date.now() - startTime < maxWaitSeconds * 1000) {
        try {
          execSync(
            `ssh -i ${tempKeyPath} -o StrictHostKeyChecking=no -o ConnectTimeout=5 ubuntu@${host} "echo connected"`,
            { encoding: 'utf8', stdio: 'pipe' }
          );
          return; // Success
        } catch (e) {
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
      throw new Error(`SSH not available after ${maxWaitSeconds} seconds`);
    } finally {
      try {
        fs.unlinkSync(tempKeyPath);
      } catch (e) {
        // Ignore
      }
    }
  }
  
  /**
   * Install Docker on a fresh EC2 instance
   * @private
   */
  async _installDocker(host, privateKey) {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const { execSync } = require('child_process');
    
    const tempKeyPath = path.join(os.tmpdir(), `core_ssh_${Date.now()}`);
    fs.writeFileSync(tempKeyPath, privateKey, { mode: 0o600 });
    
    const dockerInstallScript = `
      sudo apt-get update && \
      sudo apt-get install -y docker.io awscli && \
      sudo systemctl enable docker && \
      sudo systemctl start docker && \
      sudo usermod -aG docker ubuntu
    `.replace(/\n\s+/g, ' ');
    
    try {
      execSync(
        `ssh -i ${tempKeyPath} -o StrictHostKeyChecking=no ubuntu@${host} "${dockerInstallScript}"`,
        { encoding: 'utf8', stdio: 'pipe' }
      );
    } finally {
      try {
        fs.unlinkSync(tempKeyPath);
      } catch (e) {
        // Ignore
      }
    }
  }
  
  // ============================================================
  // PRIVATE HELPERS
  // ============================================================
  
  /**
   * Get AWS environment variables for CLI commands
   * @private
   */
  _getAWSEnv() {
    return {
      ...process.env,
      AWS_ACCESS_KEY_ID: this.secrets.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: this.secrets.AWS_SECRET_ACCESS_KEY,
      AWS_DEFAULT_REGION: this.secrets.AWS_REGION || 'us-east-1'
    };
  }
  
  /**
   * Check prerequisites are installed
   * @private
   */
  async _checkPrerequisites() {
    const result = { success: false, missing: [], error: null };
    
    const dockerCheck = await this.executeCommand('which docker');
    if (!dockerCheck.success || !dockerCheck.output) {
      result.missing.push('docker');
    }
    
    const awsCheck = await this.executeCommand('which aws');
    if (!awsCheck.success || !awsCheck.output) {
      result.missing.push('aws-cli');
    }
    
    const dockerRunning = await this.executeCommand('docker info > /dev/null 2>&1 && echo ok');
    if (!dockerRunning.success || !dockerRunning.output?.includes('ok')) {
      result.error = 'Docker is installed but not running';
      return result;
    }
    
    if (result.missing.length > 0) {
      result.error = `Missing prerequisites: ${result.missing.join(', ')}`;
      return result;
    }
    
    result.success = true;
    return result;
  }
  
  /**
   * Set up infrastructure directory
   * @private
   */
  async _setupInfrastructureDir() {
    const result = { success: false, error: null };
    
    const commands = [
      'mkdir -p ~/.factiii/configs',
      'mkdir -p ~/.factiii/envs',
      'mkdir -p ~/.factiii/nginx'
    ];
    
    for (const cmd of commands) {
      const cmdResult = await this.executeCommand(cmd);
      if (!cmdResult.success) {
        result.error = `Failed to create directory: ${cmdResult.error}`;
        return result;
      }
    }
    
    result.success = true;
    return result;
  }
  
  /**
   * Login to ECR
   * @private
   */
  async _ecrLogin(image) {
    const result = { success: false, error: null };
    
    const regionMatch = image.match(/\.ecr\.([^.]+)\.amazonaws\.com/);
    const region = regionMatch ? regionMatch[1] : this.secrets.AWS_REGION || 'us-east-1';
    
    const registryUrl = image.split('/')[0];
    const loginCommand = `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${registryUrl}`;
    
    const loginResult = await this.executeCommand(loginCommand);
    if (!loginResult.success) {
      result.error = loginResult.error;
      return result;
    }
    
    result.success = true;
    return result;
  }
  
  /**
   * Wait for container health check
   * @private
   */
  async _waitForHealth(serviceName, envConfig, maxWaitSeconds = 60) {
    const result = { healthy: false, error: null };
    const startTime = Date.now();
    const healthEndpoint = envConfig.healthCheck || '/health';
    const port = envConfig.port || 3000;
    
    while (Date.now() - startTime < maxWaitSeconds * 1000) {
      const statusCheck = await this.executeCommand(
        `docker inspect ${serviceName} --format '{{.State.Status}}'`
      );
      
      if (statusCheck.output?.trim() !== 'running') {
        result.error = `Container status: ${statusCheck.output?.trim() || 'unknown'}`;
        return result;
      }
      
      const healthCheck = await this.executeCommand(
        `curl -sf http://localhost:${port}${healthEndpoint} > /dev/null && echo "healthy"`
      );
      
      if (healthCheck.output?.includes('healthy')) {
        result.healthy = true;
        return result;
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    result.error = `Health check timed out after ${maxWaitSeconds} seconds`;
    return result;
  }
}

module.exports = AWSEC2Provider;

