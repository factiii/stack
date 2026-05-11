/**
 * Production environment operations for AWS plugin
 * Handles production deployment, server preparation, and production-specific helpers
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import yaml from 'js-yaml';

import { sshExec } from '../../../utils/ssh-helper.js';
import { extractEnvironments } from '../../../utils/config-helpers.js';
import { generateProdCompose, generateProdNginx, prodComposeServiceName } from '../../../generators/index.js';
import { getAwsAccountId, getEcrAuthToken } from './utils/aws-helpers.js';
import { AnsibleVaultSecrets } from '../../../utils/ansible-vault-secrets.js';
import type {
  FactiiiConfig,
  EnvironmentConfig,
  DeployResult,
  EnsureServerReadyOptions,
  Stage,
} from '../../../types/index.js';

// Module-level state for SSH auth context (set by exported functions before SSH calls)
let _sshStage: Stage | undefined;
let _sshConfig: FactiiiConfig | undefined;
let _sshRootDir: string | undefined;

/**
 * Execute a command on a remote server via SSH
 * Uses module-level stage/config for password auth fallback
 */
async function sshExecCommand(envConfig: EnvironmentConfig, command: string): Promise<string> {
  return await sshExec(envConfig, command, _sshStage, _sshConfig, _sshRootDir);
}

/**
 * Write environment variables to .env file on server
 * Handles both local (on-server) and remote (SSH) execution
 */
async function writeEnvFile(
  envConfig: EnvironmentConfig,
  repoDir: string,
  environment: string,
  envVarsString: string | undefined
): Promise<void> {
  if (!envVarsString) {
    // If no env vars provided, skip writing (allow manual .env files)
    return;
  }

  const envFileName = `.env.${environment === 'production' ? 'prod' : environment}`;
  const isOnServer = process.env.GITHUB_ACTIONS === 'true';

  // Parse env vars string (newline-separated KEY=VALUE format)
  const envVars = envVarsString
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .filter((line) => line.includes('='));

  if (envVars.length === 0) {
    console.log(`   ⚠️  No environment variables found in ${environment} secrets`);
    return;
  }

  // Build env file content
  const envFileContent = envVars.join('\n') + '\n';

  if (isOnServer) {
    // We're on the server - write directly
    const expandedRepoDir = repoDir.replace('~', process.env.HOME ?? '/home/ubuntu');
    const envFilePath = path.join(expandedRepoDir, envFileName);

    console.log(`   📝 Writing ${envFileName} (${envVars.length} variables)...`);
    fs.writeFileSync(envFilePath, envFileContent, 'utf8');
  } else {
    // We're remote - SSH to write
    console.log(`   📝 Writing ${envFileName} on remote server (${envVars.length} variables)...`);

    await sshExecCommand(
      envConfig,
      `cat > ${repoDir}/${envFileName} << 'ENVEOF'
${envFileContent}ENVEOF`
    );
  }
}

// ============================================================
// CRITICAL: SSL Certificate Management
// ============================================================
// Why this exists: Automatically obtain/renew Let's Encrypt SSL certificates
// What breaks if changed: HTTPS will fail, browsers show security warnings
// Dependencies: Docker must be installed, ssl_email must be configured
// Uses Docker certbot for portability (no host certbot installation needed)
// ============================================================

/**
 * Run certbot to obtain/renew SSL certificates using Docker
 * Called after nginx.conf is generated but before containers start
 * Collects all domains from all environments in stack.yml and obtains certificates
 * Uses standalone mode with Docker certbot (nginx must be stopped first)
 */
async function runCertbot(
  envConfig: EnvironmentConfig,
  config: FactiiiConfig
): Promise<void> {
  // Only get certificate for the current environment's domain (not all environments)
  const domains: string[] = [];
  if (envConfig.domain &&
      !envConfig.domain.toUpperCase().startsWith('EXAMPLE') &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(envConfig.domain)) { // Skip IP addresses — certbot needs real domains
    domains.push(envConfig.domain);
  }

  if (domains.length === 0) {
    console.log('      No domains configured, skipping SSL certificates');
    return;
  }

  const sslEmail = envConfig.ssl_email ?? config.ssl_email;
  if (!sslEmail || sslEmail.toUpperCase().startsWith('EXAMPLE')) {
    console.log('      ⚠️  ssl_email not configured in stack.yml, skipping SSL');
    console.log('      Add ssl_email to your environment config in stack.yml');
    return;
  }

  // For each domain, obtain certificate using Docker certbot
  for (const domain of domains) {
    console.log(`      Obtaining SSL certificate for: ${domain}`);

    // Build Docker certbot command (standalone mode - port 80 must be free)
    const certbotCmd = [
      'docker run --rm',
      '-v /etc/letsencrypt:/etc/letsencrypt',
      '-v /var/lib/letsencrypt:/var/lib/letsencrypt',
      '-p 80:80',
      'certbot/certbot certonly',
      '--standalone',
      '-d ' + domain,
      '--email ' + sslEmail,
      '--agree-tos',
      '--non-interactive',
    ].join(' ');

    try {
      await sshExecCommand(envConfig, certbotCmd);
      console.log(`      ✅ SSL certificate obtained for ${domain}`);
    } catch (error) {
      console.log(`      ⚠️  Certbot failed for ${domain}, continuing without SSL`);
    }
  }
}

/**
 * Setup automatic certificate renewal via cron using Docker certbot
 * Only runs once - checks if renewal is already configured
 */
async function setupCertbotRenewal(envConfig: EnvironmentConfig): Promise<void> {
  console.log('      Setting up automatic certificate renewal...');

  // Docker certbot renewal command (webroot mode since nginx will be running)
  const renewCmd = 'docker run --rm -v /etc/letsencrypt:/etc/letsencrypt -v /var/lib/letsencrypt:/var/lib/letsencrypt -v /var/www/certbot:/var/www/certbot certbot/certbot renew --quiet && docker exec factiii_nginx nginx -s reload';

  // Check if certbot renewal is already configured
  const cronCheck = await sshExecCommand(
    envConfig,
    'crontab -l 2>/dev/null | grep "certbot/certbot renew" || echo "NOT_FOUND"'
  );

  if (cronCheck.includes('NOT_FOUND')) {
    // Add renewal cron job (runs twice daily)
    await sshExecCommand(
      envConfig,
      `(crontab -l 2>/dev/null; echo "0 0,12 * * * ${renewCmd}") | crontab -`
    );
    console.log('      ✅ Configured automatic certificate renewal (twice daily)');
  } else {
    console.log('      ✅ Certificate renewal already configured');
  }
}

/**
 * Update docker-compose.yml to replace build context with ECR image for prod services
 * This is called after generate-all.js runs (which generates generic compose with build context)
 */
async function updateComposeForECR(
  envConfig: EnvironmentConfig,
  config: FactiiiConfig,
  ecrRegistry: string
): Promise<void> {
  const repoName = config.name ?? 'app';
  const serviceName = `${repoName}-prod`;
  const ecrRepository = config.ecr_repository ?? repoName;
  const imageTag = `${ecrRegistry}/${ecrRepository}:latest`;

  // Read docker-compose.yml from server
  const composeContent = await sshExecCommand(
    envConfig,
    'cat ~/.factiii/docker-compose.yml'
  );

  // Parse and update
  const compose = yaml.load(composeContent) as {
    services?: Record<
      string,
      {
        build?: { context?: string; dockerfile?: string };
        image?: string;
        [key: string]: unknown;
      }
    >;
    [key: string]: unknown;
  };

  if (compose.services && compose.services[serviceName]) {
    // Remove build section and set image to ECR
    delete compose.services[serviceName].build;
    compose.services[serviceName].image = imageTag;
  }

  // Write back to server
  const updatedContent = yaml.dump(compose, { lineWidth: -1 });
  await sshExecCommand(
    envConfig,
    `cat > ~/.factiii/docker-compose.yml << 'EOF'\n${updatedContent}\nEOF`
  );
}

/**
 * Ensure server is ready for deployment.
 *
 * Prod servers only need sshd + Docker — no node, no git, no source. Source
 * never reaches prod; deployProd() ships a generated docker-compose.yml and
 * pulls a pre-built image from ECR. This step only writes per-stage state
 * (.env file + AWS credentials) that the running container needs.
 *
 * `options.commitHash` / `branch` / `repoUrl` are accepted for interface
 * compatibility with staging's ensureServerReady but ignored on prod.
 */
export async function ensureServerReady(
  config: FactiiiConfig,
  environment: string,
  _options: EnsureServerReadyOptions = {}
): Promise<DeployResult> {
  // AWS only handles prod-type environments (prod, prod2, production, etc.)
  if (!environment.startsWith('prod') && environment !== 'production') {
    return { success: true, message: 'AWS only handles production environments' };
  }

  // Set module-level SSH auth context for password fallback
  _sshStage = 'prod';
  _sshConfig = config;

  // Get environment config (supports both v1.x and v2.0.0+ formats)
  const environments = extractEnvironments(config);
  const envConfig = environments[environment] ?? environments['prod'] ?? environments['production'];

  if (!envConfig?.domain) {
    throw new Error(`${environment} domain not configured`);
  }

  const repoName = config.name ?? 'app';
  const repoDir = `~/.factiii/${repoName}`;

  try {
    // Ensure the artifact dir exists. This is the only filesystem prep prod
    // needs — docker-compose.yml + .env files live here.
    await sshExecCommand(envConfig, `mkdir -p ${repoDir}`);

    // Write environment variables from GitHub secrets if provided
    const envVarsString = process.env.PROD_ENVS;
    if (envVarsString) {
      console.log('   Writing environment variables...');
      await writeEnvFile(envConfig, repoDir, 'prod', envVarsString);
    } else {
      console.log('   ⚠️  PROD_ENVS not provided, skipping env file write (using existing .env.prod if present)');
    }

    // Auto-configure AWS credentials on server from Ansible Vault
    if (config.ansible?.vault_path) {
      try {
        const vault = new AnsibleVaultSecrets({
          vault_path: config.ansible.vault_path,
          vault_password_file: config.ansible.vault_password_file,
          rootDir: process.cwd(),
        });
        const accessKeyId = await vault.getSecret('AWS_ACCESS_KEY_ID');
        const secretKey = await vault.getSecret('AWS_SECRET_ACCESS_KEY');
        const region = config.aws?.region ?? 'us-east-1';

        if (accessKeyId && secretKey) {
          console.log('   🔑 Configuring AWS credentials on server from vault...');
          await sshExecCommand(envConfig,
            'mkdir -p ~/.aws && ' +
            "cat > ~/.aws/credentials << 'AWSEOF'\n" +
            '[default]\n' +
            'aws_access_key_id = ' + accessKeyId + '\n' +
            'aws_secret_access_key = ' + secretKey + '\n' +
            'AWSEOF\n' +
            "cat > ~/.aws/config << 'AWSEOF'\n" +
            '[default]\n' +
            'region = ' + region + '\n' +
            'output = json\n' +
            'AWSEOF'
          );
          console.log('   ✅ AWS credentials configured on server');
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log('   ⚠️  Could not auto-configure AWS on server: ' + msg);
      }
    }

    return { success: true, message: 'Server ready' };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to prepare server: ${errorMessage}`);
  }
}

/**
 * Deploy to production server (pull from ECR)
 *
 * @param config - Factiii config (supports both v1.x and v2.0.0+)
 * @param environment - Environment name (defaults to 'prod' for backward compatibility)
 */
export async function deployProd(
  config: FactiiiConfig,
  environment: string = 'prod'
): Promise<DeployResult> {
  // Set module-level SSH auth context for password fallback
  _sshStage = 'prod';
  _sshConfig = config;

  // Get environment config (supports both v1.x and v2.0.0+ formats)
  const environments = extractEnvironments(config);
  const envConfig = environments[environment] ?? environments['prod'] ?? environments['production'];

  if (!envConfig?.domain) {
    return { success: false, error: `${environment} domain not configured` };
  }

  console.log(`   🚀 Deploying to production (${envConfig.domain})...`);

  try {
    const repoName = config.name ?? 'app';
    const region = config.aws?.region ?? 'us-east-1';

    // Resolve AWS values on dev machine via SDK (no AWS CLI needed on server)
    // If credentials fail, try restoring from Ansible Vault
    let accountId = await getAwsAccountId(region);
    if (!accountId && config.ansible?.vault_path) {
      try {
        const { AnsibleVaultSecrets } = await import('../../../utils/ansible-vault-secrets.js');
        const vault = new AnsibleVaultSecrets({
          vault_path: config.ansible.vault_path,
          vault_password_file: config.ansible.vault_password_file,
        });
        const accessKeyId = await vault.getSecret('AWS_ACCESS_KEY_ID');
        const secretKey = await vault.getSecret('AWS_SECRET_ACCESS_KEY');
        if (accessKeyId && secretKey) {
          const { setLoadedCredentials } = await import('./utils/aws-helpers.js');
          setLoadedCredentials({ accessKeyId, secretAccessKey: secretKey, region });
          accountId = await getAwsAccountId(region);
          if (accountId) {
            console.log('   [OK] Restored AWS credentials from vault');
          }
        }
      } catch { /* vault read failed */ }
    }

    let ecrRegistry: string;
    if (config.ecr_registry) {
      ecrRegistry = config.ecr_registry;
    } else {
      if (!accountId) {
        return { success: false, error: 'Failed to get AWS account ID. Check AWS credentials on dev machine.' };
      }
      ecrRegistry = accountId + '.dkr.ecr.' + region + '.amazonaws.com';
    }

    const ecrAuth = await getEcrAuthToken(region);
    if (!ecrAuth) {
      return { success: false, error: 'Failed to get ECR auth token. Check AWS credentials on dev machine.' };
    }

    // Check if docker-compose.yml already exists on server (preserves existing configs)
    const composeCheck = await sshExecCommand(
      envConfig,
      'test -f ~/docker-compose.yml && echo "HOME_EXISTS" || (test -f ~/.factiii/docker-compose.yml && echo "FACTIII_EXISTS" || echo "NOT_FOUND")'
    );

    const ecrRepository = config.ecr_repository ?? repoName;
    const imageTag = `${ecrRegistry}/${ecrRepository}:latest`;

    if (composeCheck.includes('HOME_EXISTS')) {
      // Existing production setup: docker-compose.yml in ~/
      // Preserve existing configs — only pull new image and restart
      console.log('   ✅ Found existing docker-compose.yml in ~/ — preserving configs');

      // Detect the prod service name using docker compose (most reliable)
      // Falls back to parsing docker-compose.yml if docker compose is unavailable
      let composeServiceKey: string;
      try {
        // Use docker compose to find the service that uses our ECR image
        const serviceList = await sshExecCommand(envConfig,
          'cd ~ && docker compose ps --format json 2>/dev/null || docker compose ps'
        );
        // Look for the service using our ECR image (factiii-server)
        const ecrImagePattern = ecrRepository ?? repoName;
        const jsonServices = serviceList.split('\n').filter(l => l.startsWith('{'));
        let foundService = '';
        for (const line of jsonServices) {
          try {
            const svc = JSON.parse(line);
            if (svc.Image && svc.Image.includes(ecrImagePattern)) {
              foundService = svc.Service || svc.Name || '';
              break;
            }
          } catch { /* skip non-JSON lines */ }
        }
        composeServiceKey = foundService || 'prodFactiii';
      } catch {
        composeServiceKey = 'prodFactiii';
      }

      console.log(`   📦 Detected prod service: ${composeServiceKey}`);

      // Step 1: Login to ECR and pull latest image
      console.log('   🔐 Logging in to ECR and pulling image...');
      await sshExecCommand(
        envConfig,
        'echo ' + JSON.stringify(ecrAuth.password) + ' | docker login --username ' + ecrAuth.username + ' --password-stdin ' + ecrRegistry + ' && ' +
        'cd ~ && ' +
        'docker compose pull ' + composeServiceKey
      );

      // Step 2: Restart only the prod container (nginx, certbot untouched)
      console.log('   🚀 Restarting prod container...');
      await sshExecCommand(
        envConfig,
        'cd ~ && docker compose up -d ' + composeServiceKey
      );
    } else if (composeCheck.includes('FACTIII_EXISTS')) {
      // Managed by stack: docker-compose.yml already exists in ~/.factiii/ on server
      // Update ECR image reference in-place (reads/writes via SSH, no local files needed)
      console.log('   🔄 Updating docker-compose.yml with ECR image...');
      await updateComposeForECR(envConfig, config, ecrRegistry);

      console.log('   🔐 Logging in to ECR and pulling image...');
      await sshExecCommand(
        envConfig,
        'sudo docker login --username ' + ecrAuth.username + ' --password-stdin ' + ecrRegistry + ' <<< ' + JSON.stringify(ecrAuth.password) + ' && ' +
        'cd ~/.factiii && ' +
        'sudo docker compose pull ' + repoName + '-prod'
      );

      console.log('   🔐 Managing SSL certificates...');
      try {
        await runCertbot(envConfig, config);
        await setupCertbotRenewal(envConfig);
      } catch (certErr) {
        console.log('   ⚠️  SSL setup skipped: ' + (certErr instanceof Error ? certErr.message : String(certErr)));
      }

      console.log('   🚀 Starting containers...');
      await sshExecCommand(
        envConfig,
        'cd ~/.factiii && sudo docker compose up -d ' + repoName + '-prod'
      );
    } else {
      // Fresh server: no docker-compose.yml found
      // Generate docker-compose.yml + nginx.conf from project config and upload to server
      console.log('   🆕 No docker-compose.yml found — generating from project config...');

      const ecrRepository = config.ecr_repository ?? repoName;
      const imageTag = ecrRegistry + '/' + ecrRepository + ':latest';
      const serviceName = prodComposeServiceName(config, 'prod');
      const domain = envConfig.domain ?? 'localhost';

      const composeContent = generateProdCompose(config, {
        stage: 'prod',
        imageTag,
        envConfig,
      });
      console.log('   📝 Uploading docker-compose.yml to server...');
      await sshExecCommand(envConfig,
        "mkdir -p ~/.factiii && cat > ~/.factiii/docker-compose.yml << 'COMPOSEEOF'\n" + composeContent + '\nCOMPOSEEOF'
      );

      // HTTP-only initially — certbot rewrites to add HTTPS after the cert is obtained.
      const nginxContent = generateProdNginx(config, {
        stage: 'prod',
        domain,
      });
      console.log('   📝 Uploading nginx.conf to server...');
      await sshExecCommand(envConfig,
        "cat > ~/.factiii/nginx.conf << 'NGINXEOF'\n" + nginxContent + '\nNGINXEOF'
      );

      // Install Docker + Docker Compose on server if missing (must happen before any docker commands)
      try {
        await sshExecCommand(envConfig, 'docker compose version');
        console.log('   ✅ Docker is ready');
      } catch {
        console.log('   🐳 Installing Docker on server...');
        await sshExecCommand(envConfig,
          'sudo apt-get update -qq && ' +
          'curl -fsSL https://get.docker.com | sh && ' +
          'sudo usermod -aG docker $USER && ' +
          'sudo systemctl enable docker && sudo systemctl start docker'
        );
        // newgrp docker doesn't work over SSH, use sudo for first run
        console.log('   ✅ Docker installed');
      }

      console.log('   🔐 Logging in to ECR and pulling image...');
      await sshExecCommand(
        envConfig,
        'sudo docker login --username ' + ecrAuth.username + ' --password-stdin ' + ecrRegistry + ' <<< ' + JSON.stringify(ecrAuth.password) + ' && ' +
        'cd ~/.factiii && ' +
        'sudo docker compose pull ' + serviceName
      );

      console.log('   🔐 Managing SSL certificates...');
      try {
        await runCertbot(envConfig, config);
        await setupCertbotRenewal(envConfig);
      } catch (certErr) {
        console.log('   ⚠️  SSL setup skipped (will use HTTP): ' + (certErr instanceof Error ? certErr.message : String(certErr)));
      }

      console.log('   🚀 Starting containers...');
      await sshExecCommand(
        envConfig,
        'cd ~/.factiii && sudo docker compose up -d'
      );
    }

    // Step 6: Run database migrations if Prisma is detected
    {
      const repoName2 = config.name ?? 'app';
      const serviceName2 = repoName2 + '-prod';
      try {
        // Check if container has prisma schema
        const hasPrisma = await sshExecCommand(envConfig,
          'sudo docker exec ' + serviceName2 + ' sh -c "find / -name schema.prisma -maxdepth 5 2>/dev/null | head -1"'
        );
        if (hasPrisma.trim()) {
          console.log('   🗃️ Running database migrations...');
          // Get the directory containing schema.prisma
          const schemaPath = hasPrisma.trim();
          const schemaDir = schemaPath.substring(0, schemaPath.lastIndexOf('/'));
          const workDir = schemaDir.replace(/\/prisma$/, '');

          // Install prisma CLI temporarily and run migrate deploy
          const migrateResult = await sshExecCommand(envConfig,
            'sudo docker exec -w ' + workDir + ' ' + serviceName2 + ' sh -c "' +
            'npm install --no-save prisma @prisma/config @prisma/client 2>/dev/null && ' +
            'npx prisma migrate deploy 2>&1' +
            '"'
          );
          if (migrateResult.includes('All migrations have been successfully applied') ||
              migrateResult.includes('migrations applied') ||
              migrateResult.includes('already in sync')) {
            console.log('   ✅ Database migrations applied');
          } else if (migrateResult.includes('No pending migrations')) {
            console.log('   ✅ Database already up to date');
          } else {
            console.log('   📝 Migration output: ' + migrateResult.trim().split('\n').pop());
          }

          // Restart app container to pick up fresh schema
          await sshExecCommand(envConfig,
            'cd ~/.factiii && sudo docker compose restart ' + serviceName2
          );
          console.log('   🔄 Restarted app container');
        }
      } catch (migErr) {
        const migMsg = migErr instanceof Error ? migErr.message : String(migErr);
        console.log('   ⚠️  Migration step: ' + migMsg.split('\n')[0]);
      }
    }

    // Step 7: Post-deploy health check
    console.log('   🔍 Running post-deploy health check...');
    try {
      const healthResult = await sshExecCommand(
        envConfig,
        'sleep 5 && curl -s -o /dev/null -w "%{http_code}" http://localhost:80 || echo "000"'
      );
      const statusCode = healthResult.trim();
      if (statusCode === '200' || statusCode === '301' || statusCode === '302') {
        console.log('   Health check passed (HTTP ' + statusCode + ')');
      } else {
        console.log('   Health check returned HTTP ' + statusCode + ' — app may still be starting');
      }
    } catch {
      console.log('   Health check could not connect — app may still be starting');
    }

    return { success: true, message: 'Production deployment complete' };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

