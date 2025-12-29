/**
 * Production environment operations for AWS plugin
 * Handles production deployment, server preparation, and production-specific helpers
 */

import yaml from 'js-yaml';

import { sshExec } from '../../../utils/ssh-helper.js';
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
      'curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs'
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
    await sshExecCommand(envConfig, 'sudo apt-get update && sudo apt-get install -y git');
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
  if (environment !== 'prod' && environment !== 'production') {
    return { success: true, message: 'AWS only handles production' };
  }

  const envConfig =
    config.environments?.prod ?? config.environments?.production;
  if (!envConfig?.host) {
    throw new Error('Production host not configured');
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

    // Note: Production doesn't install dependencies - it pulls pre-built images from ECR

    return { success: true, message: 'Server ready' };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to prepare server: ${errorMessage}`);
  }
}

/**
 * Deploy to production server (pull from ECR)
 */
export async function deployProd(config: FactiiiConfig): Promise<DeployResult> {
  const envConfig =
    config.environments?.prod ?? config.environments?.production;
  if (!envConfig?.host) {
    return { success: false, error: 'Production host not configured' };
  }

  console.log(`   🚀 Deploying to production (${envConfig.host})...`);

  try {
    const repoName = config.name ?? 'app';
    const region = config.aws?.region ?? 'us-east-1';

    // Step 1: Regenerate unified docker-compose.yml (generic, uses build context)
    console.log('   🔄 Regenerating unified docker-compose.yml...');
    await sshExecCommand(
      envConfig,
      `if [ -f ~/.factiii/scripts/generate-all.js ]; then \
         node ~/.factiii/scripts/generate-all.js; \
       else \
         echo "⚠️  generate-all.js not found, skipping regeneration"; \
       fi`
    );

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

    // Step 4: Start containers using unified docker-compose.yml
    console.log('   🚀 Starting containers with unified docker-compose.yml...');
    await sshExecCommand(
      envConfig,
      `cd ~/.factiii && docker compose up -d ${repoName}-prod`
    );

    return { success: true, message: 'Production deployment complete' };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

