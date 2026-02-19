/**
 * Production environment operations for AWS plugin
 * Handles production deployment, server preparation, and production-specific helpers
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

import { sshExec } from '../../../utils/ssh-helper.js';
import { extractEnvironments } from '../../../utils/config-helpers.js';
import { generateDockerCompose, generateNginx, scanRepos, loadConfigs } from '../../../scripts/index.js';
import type {
  FactiiiConfig,
  EnvironmentConfig,
  DeployResult,
  EnsureServerReadyOptions,
} from '../../../types/index.js';

/**
 * Execute a command on a remote server via SSH
 */
async function sshExecCommand(envConfig: EnvironmentConfig, command: string): Promise<string> {
  return await sshExec(envConfig, command);
}

/**
 * Ensure Node.js is installed on the server
 */
async function ensureNodeInstalled(envConfig: EnvironmentConfig): Promise<void> {
  try {
    await sshExecCommand(envConfig, 'which node');
  } catch {
    console.log('      Installing Node.js...');
    await sshExecCommand(
      envConfig,
      'curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs'
    );
  }
}

/**
 * Ensure git is installed on the server
 */
async function ensureGitInstalled(envConfig: EnvironmentConfig): Promise<void> {
  try {
    await sshExecCommand(envConfig, 'which git');
  } catch {
    console.log('      Installing git...');
    await sshExecCommand(envConfig, 'sudo DEBIAN_FRONTEND=noninteractive apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y git');
  }
}

/**
 * Ensure repository is cloned
 */
async function ensureRepoCloned(
  envConfig: EnvironmentConfig,
  repoUrl: string | undefined,
  repoDir: string,
  repoName: string
): Promise<void> {
  const checkExists = await sshExecCommand(
    envConfig,
    `test -d ${repoDir}/.git && echo "exists" || echo "missing"`
  );

  if (checkExists.includes('missing')) {
    console.log('      Cloning repository...');

    // Extract GitHub repo from URL if provided, otherwise use GITHUB_REPO env var
    let gitUrl = repoUrl;
    if (repoUrl && !repoUrl.startsWith('git@') && !repoUrl.startsWith('https://')) {
      // Format: owner/repo
      gitUrl = `git@github.com:${repoUrl}.git`;
    }

    await sshExecCommand(
      envConfig,
      `mkdir -p ~/.factiii && cd ~/.factiii && git clone ${gitUrl} ${repoName}`
    );
  }
}

/**
 * Pull latest changes and checkout specific commit
 */
async function pullAndCheckout(
  envConfig: EnvironmentConfig,
  repoDir: string,
  branch: string,
  commitHash: string | undefined
): Promise<void> {
  console.log(
    `      Checking out ${branch}${commitHash ? ' @ ' + commitHash.substring(0, 7) : ''}...`
  );

  const commands = [
    `cd ${repoDir}`,
    'git fetch --all',
    `git checkout ${branch}`,
    `git pull origin ${branch}`,
  ];

  // If commit hash provided, checkout that specific commit
  if (commitHash) {
    commands.push(`git checkout ${commitHash}`);
  }

  await sshExecCommand(envConfig, commands.join(' && '));
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
 * Collects all domains from all environments in factiii.yml and obtains certificates
 * Uses standalone mode with Docker certbot (nginx must be stopped first)
 */
async function runCertbot(
  envConfig: EnvironmentConfig,
  config: FactiiiConfig
): Promise<void> {
  const environments = extractEnvironments(config);

  // Collect all domains that need certificates
  const domains: string[] = [];
  for (const env of Object.values(environments)) {
    if (env.domain && !env.domain.startsWith('EXAMPLE-')) {
      domains.push(env.domain);
    }
  }

  if (domains.length === 0) {
    console.log('      No domains configured, skipping SSL certificates');
    return;
  }

  const sslEmail = config.ssl_email;
  if (!sslEmail || sslEmail.startsWith('EXAMPLE-')) {
    console.log('      ⚠️  ssl_email not configured in factiii.yml, skipping SSL');
    console.log('      Add ssl_email to factiii.yml to enable automatic SSL certificates');
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
  config: FactiiiConfig
): Promise<void> {
  const repoName = config.name ?? 'app';
  const region = config.aws?.region ?? 'us-east-1';
  const serviceName = `${repoName}-prod`;

  // Get ECR registry - use config value or construct from AWS account ID on server
  let ecrRegistry: string;
  if (config.ecr_registry) {
    ecrRegistry = config.ecr_registry;
  } else {
    // Get AWS account ID from the server
    try {
      const accountId = await sshExecCommand(
        envConfig,
        `aws sts get-caller-identity --query Account --output text --region ${region}`
      );
      ecrRegistry = `${accountId.trim()}.dkr.ecr.${region}.amazonaws.com`;
    } catch (error) {
      throw new Error(
        `Failed to get AWS account ID from server: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

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
 * Ensure server is ready for deployment
 * Installs Node.js, git, clones repo, checks out commit
 * Note: Production doesn't install dependencies (pulls pre-built images)
 */
export async function ensureServerReady(
  config: FactiiiConfig,
  environment: string,
  options: EnsureServerReadyOptions = {}
): Promise<DeployResult> {
  // AWS only handles prod-type environments (prod, prod2, production, etc.)
  if (!environment.startsWith('prod') && environment !== 'production') {
    return { success: true, message: 'AWS only handles production environments' };
  }

  // Get environment config (supports both v1.x and v2.0.0+ formats)
  const environments = extractEnvironments(config);
  const envConfig = environments[environment] ?? environments['prod'] ?? environments['production'];

  if (!envConfig?.domain) {
    throw new Error(`${environment} domain not configured`);
  }

  const { commitHash, branch = 'main', repoUrl } = options;
  const repoName = config.name ?? 'app';
  const repoDir = `~/.factiii/${repoName}`;

  try {
    // 1. Ensure Node.js is installed
    console.log('   Checking Node.js...');
    await ensureNodeInstalled(envConfig);

    // 2. Ensure git is installed
    console.log('   Checking git...');
    await ensureGitInstalled(envConfig);

    // 3. Ensure repo is cloned and up to date
    console.log('   Syncing repository...');
    await ensureRepoCloned(envConfig, repoUrl, repoDir, repoName);
    await pullAndCheckout(envConfig, repoDir, branch, commitHash);

    // 4. Write environment variables from GitHub secrets if provided
    const envVarsString = process.env.PROD_ENVS;
    if (envVarsString) {
      console.log('   Writing environment variables...');
      await writeEnvFile(envConfig, repoDir, 'prod', envVarsString);
    } else {
      console.log('   ⚠️  PROD_ENVS not provided, skipping env file write (using existing .env.prod if present)');
    }

    // Note: Production doesn't install dependencies - it pulls pre-built images from ECR

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

    // Step 1: Regenerate unified docker-compose.yml (generic, uses build context)
    console.log('   🔄 Regenerating unified docker-compose.yml...');
    const repos = scanRepos();
    const configs = loadConfigs(repos);
    generateDockerCompose(configs);
    generateNginx(configs);

    // Step 2: Update docker-compose.yml to use ECR image for prod services
    console.log('   🔄 Updating docker-compose.yml with ECR image references...');
    await updateComposeForECR(envConfig, config);

    // Step 3: Login to ECR and pull latest image
    console.log('   🔐 Logging in to ECR and pulling image...');
    await sshExecCommand(
      envConfig,
      `
      aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin $(aws sts get-caller-identity --query Account --output text).dkr.ecr.${region}.amazonaws.com && \
      cd ~/.factiii && \
      docker compose pull ${repoName}-prod
    `
    );

    // Step 4: Manage SSL certificates
    console.log('   🔐 Managing SSL certificates...');
    await runCertbot(envConfig, config);
    await setupCertbotRenewal(envConfig);

    // Step 5: Start containers using unified docker-compose.yml
    console.log('   🚀 Starting containers with unified docker-compose.yml...');
    await sshExecCommand(
      envConfig,
      `cd ~/.factiii && docker compose up -d ${repoName}-prod`
    );

    // Step 6: Post-deploy health check
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

