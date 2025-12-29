/**
 * Staging environment operations for Mac Mini plugin
 * Handles staging deployment, server preparation, and staging-specific helpers
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
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
      'brew install node || (curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs)'
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
    await sshExecCommand(envConfig, 'brew install git || sudo apt-get install -y git');
  }
}

/**
 * Ensure pnpm is installed on the server
 */
async function ensurePnpmInstalled(envConfig: EnvironmentConfig): Promise<void> {
  try {
    await sshExecCommand(envConfig, 'which pnpm');
  } catch {
    console.log('      Installing pnpm...');
    await sshExecCommand(envConfig, 'npm install -g pnpm@9');
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
 * Install dependencies using pnpm
 */
async function installDependencies(
  envConfig: EnvironmentConfig,
  repoDir: string
): Promise<void> {
  await sshExecCommand(envConfig, `cd ${repoDir} && pnpm install`);
}


/**
 * Ensure server is ready for deployment
 * Installs Node.js, git, pnpm, clones repo, checks out commit
 */
export async function ensureServerReady(
  config: FactiiiConfig,
  environment: string,
  options: EnsureServerReadyOptions = {}
): Promise<DeployResult> {
  if (environment !== 'staging') {
    return { success: true, message: 'Mac Mini only handles staging' };
  }

  const envConfig = config.environments?.staging;
  if (!envConfig?.host) {
    throw new Error('Staging host not configured');
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

    // 4. Ensure pnpm is installed
    console.log('   Checking pnpm...');
    await ensurePnpmInstalled(envConfig);

    // 5. Install dependencies
    console.log('   Installing dependencies...');
    await installDependencies(envConfig, repoDir);

    return { success: true, message: 'Server ready' };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to prepare server: ${errorMessage}`);
  }
}

/**
 * Update docker-compose.yml to replace build context with staging image tag
 * This is called after buildStagingImage() completes to ensure docker-compose uses the pre-built image
 */
async function updateComposeForStagingImage(
  envConfig: EnvironmentConfig,
  config: FactiiiConfig
): Promise<void> {
  const repoName = config.name ?? 'app';
  const serviceName = `${repoName}-staging`;
  const imageTag = `${repoName}:staging`;

  const isOnServer = process.env.GITHUB_ACTIONS === 'true';

  if (isOnServer) {
    // We're on the server - read and update directly
    const factiiiDir = path.join(process.env.HOME ?? '/Users/jon', '.factiii');
    const composePath = path.join(factiiiDir, 'docker-compose.yml');

    if (!fs.existsSync(composePath)) {
      console.log('   ⚠️  docker-compose.yml not found, skipping update');
      return;
    }

    const composeContent = fs.readFileSync(composePath, 'utf8');
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
      // Remove build section and set image to staging tag
      delete compose.services[serviceName].build;
      compose.services[serviceName].image = imageTag;
    }

    // Write back
    const updatedContent = yaml.dump(compose, { lineWidth: -1 });
    fs.writeFileSync(composePath, updatedContent);
  } else {
    // We're remote - SSH to update
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
      // Remove build section and set image to staging tag
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
}

/**
 * Deploy to staging environment
 * 
 * Note: Docker image building is handled by the pipeline plugin (staging.ts)
 * This method only handles deployment (regenerating docker-compose.yml and starting containers)
 */
export async function deployStaging(config: FactiiiConfig): Promise<DeployResult> {

  const envConfig = config.environments?.staging;
  if (!envConfig?.host) {
    return { success: false, error: 'Staging host not configured' };
  }

  console.log(`   🚀 Deploying on staging (${envConfig.host})...`);

  try {
    const repoName = config.name ?? 'app';
    const repoDir = `~/.factiii/${repoName}`;

    // Determine if we're running ON the server or remotely
    // When GITHUB_ACTIONS=true, we're executing on the server itself
    const isOnServer = process.env.GITHUB_ACTIONS === 'true';

    console.log(`   📍 Deployment mode: ${isOnServer ? 'on-server' : 'remote'}`);

    if (isOnServer) {
      // We're on the server - run commands directly
      const factiiiDir = path.join(process.env.HOME ?? '/Users/jon', '.factiii');

      // Step 1: Regenerate unified docker-compose.yml
      console.log('   🔄 Regenerating unified docker-compose.yml...');
      const generateAllPath = path.join(factiiiDir, 'scripts', 'generate-all.js');
      if (fs.existsSync(generateAllPath)) {
        execSync(`node ${generateAllPath}`, {
          stdio: 'inherit',
          shell: '/bin/bash',
          env: {
            ...process.env,
            PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
          },
        });
      } else {
        console.log('   ⚠️  generate-all.js not found, skipping regeneration');
      }

      // Step 2: Update docker-compose.yml to use pre-built staging image
      console.log('   🔄 Updating docker-compose.yml with staging image tag...');
      await updateComposeForStagingImage(envConfig, config);

      // Step 3: Deploy using unified docker-compose.yml
      const unifiedCompose = path.join(factiiiDir, 'docker-compose.yml');
      if (!fs.existsSync(unifiedCompose)) {
        return {
          success: false,
          error: 'Unified docker-compose.yml not found. Run generate-all.js first.',
        };
      }

      console.log('   🚀 Starting containers with unified docker-compose.yml...');
      execSync(
        `cd ${factiiiDir} && docker compose up -d`,
        {
          stdio: 'inherit',
          shell: '/bin/bash',
          env: {
            ...process.env,
            PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
          },
        }
      );
    } else {
      // We're remote - SSH to the server
      // Step 1: Regenerate unified docker-compose.yml
      console.log('   🔄 Regenerating unified docker-compose.yml on remote server...');
      await sshExecCommand(
        envConfig,
        `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && \
         if [ -f ~/.factiii/scripts/generate-all.js ]; then \
           node ~/.factiii/scripts/generate-all.js; \
         else \
           echo "⚠️  generate-all.js not found, skipping regeneration"; \
         fi`
      );

      // Step 2: Update docker-compose.yml to use pre-built staging image
      console.log('   🔄 Updating docker-compose.yml with staging image tag...');
      await updateComposeForStagingImage(envConfig, config);

      // Step 3: Deploy using unified docker-compose.yml
      console.log('   🚀 Starting containers with unified docker-compose.yml on remote server...');
      await sshExecCommand(
        envConfig,
        `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && \
         if [ ! -f ~/.factiii/docker-compose.yml ]; then \
           echo "❌ Unified docker-compose.yml not found. Run generate-all.js first." && \
           exit 1; \
         fi && \
         cd ~/.factiii && \
         docker compose up -d`
      );
    }

    return { success: true, message: 'Staging deployment complete' };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`   ❌ Deployment failed: ${errorMessage}`);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

