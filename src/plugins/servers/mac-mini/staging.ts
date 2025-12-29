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
 * Get dockerfile path from factiiiAuto.yml or use default
 */
function getDockerfilePath(repoDir: string): string {
  const autoConfigPath = path.join(repoDir, 'factiiiAuto.yml');
  if (fs.existsSync(autoConfigPath)) {
    try {
      const autoConfig = yaml.load(fs.readFileSync(autoConfigPath, 'utf8')) as {
        dockerfile?: string;
      } | null;
      if (autoConfig?.dockerfile) {
        // Remove OVERRIDE if present
        return autoConfig.dockerfile.split(' ')[0] ?? 'apps/server/Dockerfile';
      }
    } catch {
      // Ignore errors
    }
  }
  return 'apps/server/Dockerfile';
}

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
 * Ensure Docker is running before deployment
 * Starts Docker Desktop if not running and waits for it to be ready
 */
async function ensureDockerRunning(
  envConfig: EnvironmentConfig,
  isOnServer: boolean
): Promise<void> {
  const checkCmd = 'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && docker info > /dev/null 2>&1 && echo "running" || echo "stopped"';
  
  // Start Docker and wait up to 60 seconds for it to be ready
  const startCmd = `
    export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && \
    if ! docker info > /dev/null 2>&1; then
      echo "Starting Docker Desktop..." && \
      open -a Docker && \
      for i in {1..60}; do
        sleep 1
        if docker info > /dev/null 2>&1; then
          echo "Docker is ready"
          exit 0
        fi
      done
      echo "Docker failed to start within 60 seconds"
      exit 1
    else
      echo "Docker is already running"
    fi
  `;

  if (isOnServer) {
    // We're on the server - run commands directly
    try {
      const result = execSync(checkCmd, { 
        encoding: 'utf8', 
        shell: '/bin/bash',
        env: {
          ...process.env,
          PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
        },
      });
      
      if (result.includes('stopped')) {
        console.log('   🐳 Starting Docker Desktop...');
        execSync(startCmd, { 
          stdio: 'inherit', 
          shell: '/bin/bash',
          env: {
            ...process.env,
            PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
          },
        });
        console.log('   ✅ Docker Desktop started');
      } else {
        console.log('   ✅ Docker is already running');
      }
    } catch (error) {
      // Docker not running, try to start it
      console.log('   🐳 Starting Docker Desktop...');
      try {
        execSync(startCmd, { 
          stdio: 'inherit', 
          shell: '/bin/bash',
          env: {
            ...process.env,
            PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
          },
        });
        console.log('   ✅ Docker Desktop started');
      } catch (startError) {
        throw new Error('Failed to start Docker Desktop. Please start it manually.');
      }
    }
  } else {
    // We're remote - run via SSH
    try {
      const result = await sshExecCommand(envConfig, checkCmd);
      if (result.includes('stopped')) {
        console.log('   🐳 Starting Docker Desktop on staging server...');
        await sshExecCommand(envConfig, startCmd);
        console.log('   ✅ Docker Desktop started');
      } else {
        console.log('   ✅ Docker is already running');
      }
    } catch {
      console.log('   🐳 Starting Docker Desktop on staging server...');
      try {
        await sshExecCommand(envConfig, startCmd);
        console.log('   ✅ Docker Desktop started');
      } catch (startError) {
        throw new Error('Failed to start Docker Desktop on staging server. Please start it manually.');
      }
    }
  }
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
 * Deploy to staging environment
 */
export async function deployStaging(config: FactiiiConfig): Promise<DeployResult> {
  // ============================================================
  // CRITICAL: Deployment Flow - Staging vs Production
  // ============================================================
  // STAGING (this method):
  //   - Workflow SSHes to staging server
  //   - Runs: GITHUB_ACTIONS=true deploy --staging
  //   - Builds Docker image locally (arm64, no ECR push)
  //   - Runs generate-all.js to regenerate unified docker-compose.yml
  //   - Deploys using unified ~/.factiii/docker-compose.yml
  //
  // PRODUCTION (different flow):
  //   - Workflow SSHes to STAGING server (not prod!)
  //   - Builds production image on staging (amd64)
  //   - Pushes to ECR
  //   - Workflow SSHes to prod server
  //   - Pulls from ECR and deploys using unified docker-compose.yml
  //
  // Why workflows SSH first: Allows using GitHub Secrets (SSH keys)
  // without storing them on servers. Workflow passes secrets via SSH.
  //
  // Why GITHUB_ACTIONS=true + --staging: GITHUB_ACTIONS tells pipeline
  // we're on the server (canReach returns 'local'). --staging tells
  // command to only run staging stage.
  //
  // Why both paths exist: Code checks GITHUB_ACTIONS env var:
  //   - GITHUB_ACTIONS=true → local path (Factiii workflows)
  //   - GITHUB_ACTIONS not set → remote SSH path (other workflows)
  // ============================================================

  const envConfig = config.environments?.staging;
  if (!envConfig?.host) {
    return { success: false, error: 'Staging host not configured' };
  }

  console.log(`   🔨 Building and deploying on staging (${envConfig.host})...`);

  try {
    const repoName = config.name ?? 'app';
    const repoDir = `~/.factiii/${repoName}`;

    // Determine if we're running ON the server or remotely
    // When GITHUB_ACTIONS=true, we're executing on the server itself
    const isOnServer = process.env.GITHUB_ACTIONS === 'true';

    console.log(`   📍 Deployment mode: ${isOnServer ? 'on-server' : 'remote'}`);

    // ============================================================
    // CRITICAL: Ensure Docker is running BEFORE building
    // ============================================================
    // Why this exists: Staging builds containers locally from source.
    // Unlike production (which pulls pre-built images from ECR),
    // staging needs Docker daemon running to build the images.
    // What breaks if changed: docker build fails with
    // "Cannot connect to the Docker daemon" error.
    // Dependencies: Docker Desktop must be installed and startable.
    // ============================================================
    console.log('   🐳 Checking Docker status...');
    await ensureDockerRunning(envConfig, isOnServer);

    if (isOnServer) {
      // We're on the server - run commands directly
      const expandedRepoDir = repoDir.replace('~', process.env.HOME ?? '');
      const factiiiDir = path.join(process.env.HOME ?? '/Users/jon', '.factiii');
      const dockerfile = getDockerfilePath(expandedRepoDir);
      const imageTag = `${repoName}:staging`;

      // Step 1: Build Docker image explicitly with arm64 platform
      console.log(`   🔨 Building Docker image (arm64): ${imageTag}...`);
      execSync(
        `cd ${expandedRepoDir} && docker build --platform linux/arm64 -t ${imageTag} -f ${dockerfile} .`,
        {
          stdio: 'inherit',
          shell: '/bin/bash',
          env: {
            ...process.env,
            PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
          },
        }
      );

      // Step 2: Regenerate unified docker-compose.yml
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
      const dockerfile = getDockerfilePath(
        path.join(process.env.HOME ?? '/Users/jon', '.factiii', repoName)
      );
      const imageTag = `${repoName}:staging`;

      // Step 1: Build Docker image explicitly with arm64 platform
      console.log(`   🔨 Building Docker image (arm64) on remote server: ${imageTag}...`);
      await sshExecCommand(
        envConfig,
        `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && \
         cd ${repoDir} && \
         docker build --platform linux/arm64 -t ${imageTag} -f ${dockerfile} .`
      );

      // Step 2: Regenerate unified docker-compose.yml
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

