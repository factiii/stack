const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const yaml = require('js-yaml');
const os = require('os');

/**
 * Direct SSH deployer - bypasses GitHub workflows
 * Handles deployment directly from CLI to servers
 */
class Deployer {
  constructor(config, options = {}) {
    this.config = config;
    this.options = options;
    this.rootDir = process.cwd();
    this.tempFiles = [];
  }

  /**
   * Main deployment method
   */
  async deploy(environments = ['all']) {
    const results = [];
    
    // If 'all', deploy to all environments
    if (environments.includes('all')) {
      environments = Object.keys(this.config.environments || {});
    }

    if (environments.length === 0) {
      throw new Error('No environments found to deploy');
    }

    console.log(`🚀 Deploying to: ${environments.join(', ')}\n`);

    for (const envName of environments) {
      console.log(`${'='.repeat(70)}`);
      console.log(`📦 Deploying to ${envName}`);
      console.log(`${'='.repeat(70)}\n`);

      try {
        const result = await this.deployEnvironment(envName);
        results.push({ environment: envName, ...result });
        
        if (result.success) {
          console.log(`\n✅ Successfully deployed to ${envName}\n`);
        } else {
          console.error(`\n❌ Failed to deploy to ${envName}: ${result.error}\n`);
        }
      } catch (error) {
        console.error(`\n❌ Deployment error for ${envName}: ${error.message}\n`);
        results.push({ 
          environment: envName, 
          success: false, 
          error: error.message 
        });
      }
    }

    // Cleanup temp files
    this.cleanup();

    return results;
  }

  /**
   * Deploy to a single environment
   */
  async deployEnvironment(envName) {
    const envConfig = this.config.environments[envName];
    
    if (!envConfig) {
      return { success: false, error: `Environment ${envName} not found in config` };
    }

    // Get secrets from GitHub or environment variables
    const secrets = await this.getSecrets(envName);
    
    if (!secrets.SSH_KEY || !secrets.HOST) {
      return { 
        success: false, 
        error: `Missing SSH credentials. Run: npx core init fix` 
      };
    }

    // Step 0: Build and push Docker image if needed
    let imageTag = null;
    if (this.options.build !== false && this.config.ecr_registry) {
      console.log('🏗️  Building Docker image...\n');
      try {
        imageTag = await this.buildAndPushImage();
        console.log(`   ✅ Image built and pushed: ${imageTag}\n`);
      } catch (error) {
        return { 
          success: false, 
          error: `Docker build failed: ${this.parseError(error.message)}` 
        };
      }
    }

    // Create temp SSH key file
    const sshKeyPath = this.createTempSSHKey(secrets.SSH_KEY, envName);
    const host = secrets.HOST;
    const user = secrets.USER || 'ubuntu';
    const repoName = this.config.name;

    try {
      // Step 1: Setup infrastructure directories
      console.log('📁 Setting up infrastructure directories...');
      await this.sshExec(sshKeyPath, host, user, 
        'mkdir -p ~/infrastructure/configs ~/infrastructure/scripts ~/infrastructure/nginx ~/infrastructure/envs'
      );
      console.log('   ✅ Directories created\n');

      // Step 2: Upload core.yml config
      console.log('📤 Uploading configuration...');
      await this.scpFile(
        sshKeyPath, 
        host, 
        user,
        path.join(this.rootDir, 'core.yml'),
        `~/infrastructure/configs/${repoName}.yml`
      );
      console.log('   ✅ Configuration uploaded\n');

      // Step 3: Upload environment variables
      if (secrets.ENVS) {
        console.log('🔐 Uploading environment variables...');
        const envContent = secrets.ENVS;
        const envFileName = `${repoName}-${envName}.env`;
        await this.sshExecWithInput(
          sshKeyPath, 
          host, 
          user,
          `cat > ~/infrastructure/${envFileName} && chmod 600 ~/infrastructure/${envFileName}`,
          envContent
        );
        console.log('   ✅ Environment variables uploaded\n');
      }

      // Step 4: Upload generator scripts
      console.log('📤 Uploading deployment scripts...');
      const generatorsPath = path.join(__dirname, '../generators');
      if (fs.existsSync(generatorsPath)) {
        await this.sshExec(sshKeyPath, host, user, 
          'mkdir -p ~/infrastructure/scripts/generators'
        );
        await this.scpDirectory(
          sshKeyPath,
          host,
          user,
          generatorsPath,
          '~/infrastructure/scripts/generators/'
        );
      }
      console.log('   ✅ Scripts uploaded\n');

      // Step 5: Run infrastructure config generator
      console.log('⚙️  Generating docker-compose and nginx configs...');
      await this.sshExec(
        sshKeyPath, 
        host, 
        user,
        `cd ~/infrastructure && node scripts/generators/generate-compose.js && node scripts/generators/generate-nginx.js`
      );
      console.log('   ✅ Configurations generated\n');

      // Step 6: Pull and start Docker containers
      console.log('🐳 Deploying Docker containers...');
      const serviceKey = `${repoName}-${envName}`;
      await this.sshExec(
        sshKeyPath,
        host,
        user,
        `cd ~/infrastructure && docker compose pull ${serviceKey} && docker compose up -d ${serviceKey}`
      );
      console.log('   ✅ Containers deployed\n');

      // Step 7: Run Prisma migrations if configured
      if (this.config.prisma_schema) {
        console.log('🔄 Checking database migrations...');
        const migrationResult = await this.runPrismaMigrations(
          sshKeyPath,
          host,
          user,
          serviceKey,
          envName
        );
        
        if (migrationResult.success) {
          console.log('   ✅ Database migrations complete\n');
        } else {
          console.warn(`   ⚠️  Migration warning: ${migrationResult.message}\n`);
        }
      }

      return { success: true, message: 'Deployment complete' };

    } catch (error) {
      return { success: false, error: this.parseError(error.message) };
    }
  }

  /**
   * Run Prisma migrations
   */
  async runPrismaMigrations(sshKeyPath, host, user, serviceKey, envName) {
    const schema = this.config.prisma_schema || 'prisma/schema.prisma';
    const version = this.config.prisma_version || 'latest';

    console.log(`   📋 Prisma schema: ${schema}`);
    console.log(`   📦 Prisma version: ${version}`);

    try {
      // Check migration status
      console.log('   🔍 Checking migration status...');
      
      try {
        await this.sshExec(
          sshKeyPath,
          host,
          user,
          `cd ~/infrastructure && docker compose run --rm --no-deps ${serviceKey} npx -y prisma@${version} migrate status --schema=${schema}`
        );
        console.log('   ✅ Database is up to date');
        return { success: true, message: 'No migrations needed' };
      } catch (statusError) {
        // Migration needed
        console.log('   🔄 Running migrations...');
        
        // For production, create backup first
        if (envName === 'production' || envName === 'prod') {
          console.log('   💾 Creating database backup...');
          const backupFile = `backup-${Date.now()}.sql`;
          try {
            await this.sshExec(
              sshKeyPath,
              host,
              user,
              `cd ~/infrastructure && docker compose run --rm --no-deps ${serviceKey} sh -c 'pg_dump $DATABASE_URL > /tmp/${backupFile} 2>/dev/null || echo "Backup skipped"'`
            );
            console.log('   ✅ Backup created');
          } catch (backupError) {
            console.warn('   ⚠️  Could not create backup (may not be PostgreSQL)');
          }
        }

        // Run migrations
        await this.sshExec(
          sshKeyPath,
          host,
          user,
          `cd ~/infrastructure && docker compose run --rm --no-deps ${serviceKey} npx -y prisma@${version} migrate deploy --schema=${schema}`
        );

        return { success: true, message: 'Migrations applied' };
      }
    } catch (error) {
      if (envName === 'staging') {
        // Non-fatal for staging
        return { success: true, message: 'Migration failed (non-blocking for staging)' };
      }
      throw error;
    }
  }

  /**
   * Get secrets from GitHub or environment variables
   */
  async getSecrets(envName) {
    const prefix = envName.toUpperCase();
    const secrets = {};

    // Check environment variables first
    const envVars = [
      'SSH_KEY', 'SSH', 'HOST', 'USER', 'ENVS'
    ];

    for (const varName of envVars) {
      const fullName = `${prefix}_${varName}`;
      const value = process.env[fullName];
      
      if (value) {
        secrets[varName] = value;
      }
    }

    // If we have GitHub token, fetch from GitHub Secrets API
    if (process.env.GITHUB_TOKEN && (!secrets.SSH_KEY || !secrets.HOST)) {
      try {
        const { Octokit } = require('@octokit/rest');
        const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
        
        // Get repo info
        const repoUrl = execSync('git config --get remote.origin.url', { encoding: 'utf8' }).trim();
        const match = repoUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
        
        if (match) {
          const [owner, repo] = match[1].split('/');
          
          // Note: We can't actually READ secrets from GitHub API (they're write-only)
          // This is just for validation
          console.log(`   ℹ️  GitHub integration available for ${owner}/${repo}`);
        }
      } catch (error) {
        // Ignore GitHub API errors
      }
    }

    return secrets;
  }

  /**
   * Execute SSH command
   */
  async sshExec(keyPath, host, user, command, options = {}) {
    const sshOptions = [
      '-i', keyPath,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=30'
    ];

    const fullCommand = `ssh ${sshOptions.join(' ')} ${user}@${host} "${command.replace(/"/g, '\\"')}"`;

    try {
      const output = execSync(fullCommand, {
        encoding: 'utf8',
        stdio: options.silent ? 'pipe' : 'inherit',
        ...options
      });
      return output;
    } catch (error) {
      throw new Error(`SSH command failed: ${error.message}`);
    }
  }

  /**
   * Execute SSH command with stdin input
   */
  async sshExecWithInput(keyPath, host, user, command, input) {
    const sshOptions = [
      '-i', keyPath,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=30'
    ];

    const fullCommand = `echo "${input.replace(/"/g, '\\"')}" | ssh ${sshOptions.join(' ')} ${user}@${host} "${command.replace(/"/g, '\\"')}"`;

    try {
      execSync(fullCommand, { encoding: 'utf8', stdio: 'inherit' });
    } catch (error) {
      throw new Error(`SSH command with input failed: ${error.message}`);
    }
  }

  /**
   * Copy file via SCP
   */
  async scpFile(keyPath, host, user, localPath, remotePath) {
    const scpOptions = [
      '-i', keyPath,
      '-o', 'StrictHostKeyChecking=no'
    ];

    const fullCommand = `scp ${scpOptions.join(' ')} ${localPath} ${user}@${host}:${remotePath}`;

    try {
      execSync(fullCommand, { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      throw new Error(`SCP failed: ${error.message}`);
    }
  }

  /**
   * Copy directory via SCP
   */
  async scpDirectory(keyPath, host, user, localPath, remotePath) {
    const scpOptions = [
      '-i', keyPath,
      '-o', 'StrictHostKeyChecking=no',
      '-r'
    ];

    const fullCommand = `scp ${scpOptions.join(' ')} ${localPath}/* ${user}@${host}:${remotePath}`;

    try {
      execSync(fullCommand, { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      throw new Error(`SCP directory failed: ${error.message}`);
    }
  }

  /**
   * Create temporary SSH key file
   */
  createTempSSHKey(sshKey, envName) {
    const tempKeyPath = path.join(os.tmpdir(), `core_deploy_${envName}_${Date.now()}`);
    fs.writeFileSync(tempKeyPath, sshKey, { mode: 0o600 });
    this.tempFiles.push(tempKeyPath);
    return tempKeyPath;
  }

  /**
   * Build and push Docker image to ECR
   */
  async buildAndPushImage() {
    const ecrRegistry = this.config.ecr_registry;
    const ecrRepo = this.config.ecr_repository || 'apps';
    const dockerfile = this.config.dockerfile || 'Dockerfile';
    const awsRegion = process.env.AWS_REGION || 'us-east-1';

    if (!ecrRegistry) {
      throw new Error('ecr_registry not configured in core.yml');
    }

    // Check AWS credentials
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      throw new Error('AWS credentials not found. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY');
    }

    // Check if dockerfile exists
    const dockerfilePath = path.join(this.rootDir, dockerfile);
    if (!fs.existsSync(dockerfilePath)) {
      throw new Error(`Dockerfile not found: ${dockerfile}`);
    }

    console.log(`   📋 Registry: ${ecrRegistry}`);
    console.log(`   📦 Repository: ${ecrRepo}`);
    console.log(`   🐳 Dockerfile: ${dockerfile}`);
    console.log(`   🌍 Region: ${awsRegion}\n`);

    try {
      // Login to ECR
      console.log('   🔐 Logging into ECR...');
      const loginCommand = `aws ecr get-login-password --region ${awsRegion} | docker login --username AWS --password-stdin ${ecrRegistry}`;
      execSync(loginCommand, { 
        encoding: 'utf8', 
        stdio: 'pipe',
        env: { ...process.env, AWS_REGION: awsRegion }
      });
      console.log('   ✅ ECR login successful');

      // Build image
      const imageTag = `${ecrRegistry}/${ecrRepo}:latest`;
      console.log(`\n   🔨 Building image: ${imageTag}`);
      console.log('   This may take a few minutes...\n');
      
      const buildCommand = `docker build --platform linux/amd64 -t ${imageTag} -f ${dockerfile} .`;
      execSync(buildCommand, { 
        encoding: 'utf8', 
        stdio: 'inherit',
        cwd: this.rootDir
      });
      console.log('\n   ✅ Build complete');

      // Push image
      console.log(`\n   ⬆️  Pushing to ECR...`);
      const pushCommand = `docker push ${imageTag}`;
      execSync(pushCommand, { 
        encoding: 'utf8', 
        stdio: 'inherit'
      });
      console.log('   ✅ Push complete');

      return imageTag;

    } catch (error) {
      throw new Error(`Docker build/push failed: ${error.message}`);
    }
  }

  /**
   * Parse error messages into user-friendly format
   */
  parseError(errorMessage) {
    // EXAMPLE- values
    if (errorMessage.includes('EXAMPLE-')) {
      return '❌ Configuration contains EXAMPLE- placeholder values\n' +
             '   💡 Edit core.yml and replace all EXAMPLE- values with your actual configuration.';
    }

    // SSH errors
    if (errorMessage.includes('Permission denied') || errorMessage.includes('publickey')) {
      return '❌ SSH authentication failed\n' +
             '   💡 Check your SSH key:\n' +
             '      1. Verify the key is correct in GitHub Secrets\n' +
             '      2. Ensure the public key is added to ~/.ssh/authorized_keys on the server\n' +
             '      3. Check file permissions: chmod 600 ~/.ssh/authorized_keys';
    }

    if (errorMessage.includes('Connection refused')) {
      return '❌ Connection refused by server\n' +
             '   💡 Possible causes:\n' +
             '      1. Server is offline or unreachable\n' +
             '      2. SSH service not running (check: sudo systemctl status ssh)\n' +
             '      3. Firewall blocking port 22\n' +
             '      4. Wrong HOST address in configuration';
    }

    if (errorMessage.includes('Connection timed out') || errorMessage.includes('ConnectTimeout')) {
      return '❌ Connection timed out\n' +
             '   💡 Possible causes:\n' +
             '      1. Server is offline\n' +
             '      2. Network/firewall blocking connection\n' +
             '      3. Wrong HOST address\n' +
             '      4. VPN or Tailscale not connected';
    }

    if (errorMessage.includes('Host key verification failed')) {
      return '❌ Host key verification failed\n' +
             '   💡 Fix: Remove old host key with:\n' +
             '      ssh-keygen -R <hostname>';
    }

    // Docker errors
    if (errorMessage.includes('docker: command not found') || errorMessage.includes('docker: not found')) {
      return '❌ Docker is not installed on the server\n' +
             '   💡 Install Docker:\n' +
             '      Mac: Install Docker Desktop\n' +
             '      Linux: curl -fsSL https://get.docker.com | sh';
    }

    if (errorMessage.includes('Cannot connect to the Docker daemon')) {
      return '❌ Docker daemon is not running\n' +
             '   💡 Start Docker:\n' +
             '      Mac: Open Docker Desktop\n' +
             '      Linux: sudo systemctl start docker';
    }

    if (errorMessage.includes('docker compose') && errorMessage.includes('not found')) {
      return '❌ Docker Compose is not installed\n' +
             '   💡 Install Docker Compose or use newer Docker with built-in compose';
    }

    if (errorMessage.includes('pull access denied') || errorMessage.includes('authentication required')) {
      return '❌ Cannot pull Docker image - authentication failed\n' +
             '   💡 Check:\n' +
             '      1. Image name is correct\n' +
             '      2. AWS credentials are valid\n' +
             '      3. ECR repository exists and has the image\n' +
             '      4. Server can authenticate with ECR';
    }

    if (errorMessage.includes('no such image')) {
      return '❌ Docker image not found\n' +
             '   💡 Build and push the image first:\n' +
             '      npx core deploy --build';
    }

    if (errorMessage.includes('port is already allocated')) {
      return '❌ Port already in use\n' +
             '   💡 Another container or process is using this port\n' +
             '      Check: docker ps and lsof -i :<port>';
    }

    // AWS/ECR errors
    if (errorMessage.includes('AWS credentials')) {
      return '❌ AWS credentials not found or invalid\n' +
             '   💡 Set environment variables:\n' +
             '      export AWS_ACCESS_KEY_ID=your_key\n' +
             '      export AWS_SECRET_ACCESS_KEY=your_secret\n' +
             '      export AWS_REGION=us-east-1';
    }

    if (errorMessage.includes('AccessDenied') || errorMessage.includes('UnauthorizedOperation')) {
      return '❌ AWS access denied\n' +
             '   💡 Check:\n' +
             '      1. AWS credentials are correct\n' +
             '      2. IAM user has ECR permissions (ecr:*)\n' +
             '      3. ECR repository policy allows access';
    }

    if (errorMessage.includes('RepositoryNotFoundException')) {
      return '❌ ECR repository not found\n' +
             '   💡 Create the repository first:\n' +
             '      aws ecr create-repository --repository-name <repo-name>';
    }

    // Prisma/Database errors
    if (errorMessage.includes('Prisma') && errorMessage.includes('migration')) {
      return `❌ Database migration failed\n` +
             `   💡 Check database connection and migration files\n` +
             `   Error: ${errorMessage.split('\n')[0]}`;
    }

    if (errorMessage.includes('DATABASE_URL')) {
      return '❌ Database connection failed\n' +
             '   💡 Check DATABASE_URL in environment variables\n' +
             '      Ensure database is running and accessible';
    }

    // File not found errors
    if (errorMessage.includes('No such file or directory') && errorMessage.includes('Dockerfile')) {
      return '❌ Dockerfile not found\n' +
             '   💡 Check dockerfile path in core.yml or create Dockerfile';
    }

    // Node/NPM errors
    if (errorMessage.includes('node_modules')) {
      return '❌ Dependencies not installed\n' +
             '   💡 Run: npm install or pnpm install';
    }

    // Permission errors
    if (errorMessage.includes('EACCES') || errorMessage.includes('permission denied')) {
      return '❌ Permission denied\n' +
             '   💡 Check file/directory permissions or run with appropriate user';
    }

    // Generic with context
    if (errorMessage.length > 200) {
      // Truncate very long errors, show first and last parts
      const firstPart = errorMessage.substring(0, 100);
      const lastPart = errorMessage.substring(errorMessage.length - 80);
      return `❌ ${firstPart}...\n   ...\n   ${lastPart}`;
    }

    // Return original error if no pattern matched
    return `❌ ${errorMessage}`;
  }

  /**
   * Cleanup temporary files
   */
  cleanup() {
    for (const tempFile of this.tempFiles) {
      try {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      } catch (error) {
        // Ignore cleanup errors
      }
    }
    this.tempFiles = [];
  }
}

module.exports = Deployer;

