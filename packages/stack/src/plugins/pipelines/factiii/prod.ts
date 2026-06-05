/**
 * Production Build Utilities
 * 
 * Functions for building Docker images for production environment:
 * - Builds linux/amd64 images on staging server and pushes to ECR
 */

import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';
import yaml from 'js-yaml';

import { getStackAutoPath } from '../../../constants/config-files.js';
import { AnsibleVaultSecrets } from '../../../utils/ansible-vault-secrets.js';
import { sshExec } from '../../../utils/ssh-helper.js';
import type {
  FactiiiConfig,
  EnvironmentConfig,
  DeployResult,
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
 * Get dockerfile path from stackAuto.yml (or legacy factiiiAuto.yml) or use default
 */
function getDockerfilePath(repoDir: string): string {
  const autoConfigPath = getStackAutoPath(repoDir);
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
 * Get ECR registry from config or AWS account ID via SDK
 */
export async function getECRRegistry(config: FactiiiConfig, rootDir?: string): Promise<string> {
  const region = config.aws?.region ?? 'us-east-1';

  // Use config value if provided
  if (config.ecr_registry) {
    return config.ecr_registry;
  }

  // Ensure AWS credentials are synced from vault before SDK call
  await syncAwsCredsFromVault(config, region, rootDir);

  // Construct from AWS account ID via SDK (no CLI needed)
  const { getAwsAccountId } = await import('../aws/utils/aws-helpers.js');
  const accountId = await getAwsAccountId(region);
  if (!accountId) {
    throw new Error('Failed to get AWS account ID via SDK. Check AWS credentials.\n' +
      '   Run: npx stack fix --dev   (syncs vault credentials to ~/.aws/)\n' +
      '   Or:  npx stack deploy --secrets list   (check if AWS_SECRET_ACCESS_KEY is stored)');
  }
  return accountId + '.dkr.ecr.' + region + '.amazonaws.com';
}

/**
 * Sync AWS credentials from Ansible Vault to ~/.aws/credentials if missing.
 * This ensures deploy can work without running fix first.
 */
async function syncAwsCredsFromVault(config: FactiiiConfig, region: string, rootDir?: string): Promise<void> {
  try {
    const { getLoadedCredentials } = await import('../aws/utils/aws-helpers.js');
    try {
      getLoadedCredentials();
      return; // credentials already loaded in memory
    } catch { /* not loaded — fall through to vault read */ }

    // Try to read from vault
    if (!config.ansible?.vault_path) return;
    const configKeyId = config.prod?.access_key_id;
    if (!configKeyId) return;

    const store = new AnsibleVaultSecrets({
      vault_path: config.ansible.vault_path,
      vault_password_file: config.ansible.vault_password_file,
      rootDir: rootDir ?? process.cwd(),
    });
    const secretKey = await store.getSecret('AWS_SECRET_ACCESS_KEY');
    if (secretKey) {
      const { setLoadedCredentials } = await import('../aws/utils/aws-helpers.js');
      setLoadedCredentials({ accessKeyId: configKeyId, secretAccessKey: secretKey, region });
      console.log('   [OK] Synced AWS credentials from vault');
    }
  } catch { /* vault sync is best-effort */ }
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
  // Use headless binary start over SSH since `open -a Docker` requires a GUI session
  const startCmd = `
    export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && \
    if ! docker info > /dev/null 2>&1; then
      echo "Starting Docker Desktop..." && \
      if [ -n "$SSH_CONNECTION" ] || [ -n "$SSH_CLIENT" ] || [ -n "$SSH_TTY" ]; then
        nohup /Applications/Docker.app/Contents/MacOS/Docker --unattended > /dev/null 2>&1 &
      else
        open -a Docker
      fi && \
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
 * Build production Docker image (linux/amd64) on staging server and push to ECR
 * This is called before production deployment
 */
export async function buildProductionImage(
  config: FactiiiConfig,
  stagingConfig: EnvironmentConfig
): Promise<DeployResult> {
  // Set module-level SSH auth context for password fallback
  // Prod builds happen on staging server, so use 'staging' stage for SSH
  _sshStage = 'staging';
  _sshConfig = config;

  const repoName = config.name ?? 'app';
  const region = config.aws?.region ?? 'us-east-1';

  // Get ECR registry
  let ecrRegistry: string;
  try {
    ecrRegistry = await getECRRegistry(config, _sshRootDir);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // Get ECR repository
  const ecrRepository = config.ecr_repository ?? repoName;
  const imageTag = `${ecrRegistry}/${ecrRepository}:latest`;

  console.log(`   🔨 Building production Docker image (amd64) on staging server...`);
  console.log(`      Image: ${imageTag}`);

  try {
    const repoDir = `~/.factiii/${repoName}`;
    const isOnServer = process.env.GITHUB_ACTIONS === 'true';

    // Get ECR auth token via SDK on dev machine (no AWS CLI needed on staging server)
    const { getEcrAuthToken } = await import('../aws/utils/aws-helpers.js');
    const ecrAuth = await getEcrAuthToken(region);
    if (!ecrAuth) {
      return { success: false, error: 'Failed to get ECR auth token. Check AWS credentials on dev machine.' };
    }

    // Get dockerfile path
    let dockerfile: string;
    if (isOnServer) {
      const expandedRepoDir = repoDir.replace('~', os.homedir());
      dockerfile = getDockerfilePath(expandedRepoDir);
    } else {
      // For remote, we'll use a default and let the build command handle it
      dockerfile = 'apps/server/Dockerfile';
    }

    // Ensure Docker is running
    console.log('   🐳 Checking Docker status on staging server...');
    await ensureDockerRunning(stagingConfig, isOnServer);

    // ECR login command using SDK token (no AWS CLI needed)
    const ecrLoginCmd = 'echo ' + JSON.stringify(ecrAuth.password) + ' | docker login --username ' + ecrAuth.username + ' --password-stdin ' + ecrRegistry;

    if (isOnServer) {
      // We're on the staging server - run commands directly
      const expandedRepoDir = repoDir.replace('~', os.homedir());
      const pathEnv = '/opt/homebrew/bin:/usr/local/bin:' + (process.env.PATH ?? '');

      // Step 1: Ensure buildx is available (needed for cross-platform amd64 builds on ARM Mac)
      try {
        execSync('docker buildx version', { stdio: 'pipe', shell: '/bin/bash', env: { ...process.env, PATH: pathEnv } });
      } catch {
        console.log('   Installing docker-buildx...');
        try {
          execSync('brew install docker-buildx 2>/dev/null; mkdir -p ~/.docker/cli-plugins && ln -sfn "$(brew --prefix 2>/dev/null)/bin/docker-buildx" ~/.docker/cli-plugins/docker-buildx 2>/dev/null || true', {
            stdio: 'inherit', shell: '/bin/bash', env: { ...process.env, PATH: pathEnv },
          });
        } catch { /* continue — build may still work */ }
      }

      // Step 2: Build image with amd64 platform
      console.log('   🔨 Building Docker image (amd64): ' + imageTag + '...');
      execSync(
        'cd ' + expandedRepoDir + ' && docker buildx build --platform linux/amd64 --load -t ' + imageTag + ' -f ' + dockerfile + ' .',
        {
          stdio: 'inherit',
          shell: '/bin/bash',
          env: { ...process.env, PATH: pathEnv },
        }
      );

      // Step 2: Login to ECR (using SDK token)
      console.log('   🔐 Logging in to ECR...');
      execSync(ecrLoginCmd, {
        stdio: 'inherit',
        shell: '/bin/bash',
        env: { ...process.env, PATH: pathEnv },
      });

      // Step 3: Push to ECR
      console.log('   📤 Pushing image to ECR: ' + imageTag + '...');
      execSync('docker push ' + imageTag, {
        stdio: 'inherit',
        shell: '/bin/bash',
        env: { ...process.env, PATH: pathEnv },
      });
    } else {
      // We're remote - SSH to staging server
      await sshExecCommand(
        stagingConfig,
        'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && ' +
        '(docker buildx version >/dev/null 2>&1 || (echo "Installing docker-buildx..." && brew install docker-buildx 2>/dev/null; mkdir -p ~/.docker/cli-plugins && ln -sfn "$(brew --prefix 2>/dev/null)/bin/docker-buildx" ~/.docker/cli-plugins/docker-buildx 2>/dev/null || true)) && ' +
        'cd ' + repoDir + ' && ' +
        'echo "Building Docker image (amd64): ' + imageTag + '..." && ' +
        'docker buildx build --platform linux/amd64 --load -t ' + imageTag + ' -f ' + dockerfile + ' . && ' +
        'echo "Logging in to ECR..." && ' +
        ecrLoginCmd + ' && ' +
        'echo "Pushing image to ECR: ' + imageTag + '..." && ' +
        'docker push ' + imageTag
      );
    }

    console.log(`   ✅ Production image built and pushed: ${imageTag}`);
    return { success: true, message: `Production image built and pushed: ${imageTag}` };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`   ❌ Failed to build/push production image: ${errorMessage}`);
    return {
      success: false,
      error: `Failed to build/push production image: ${errorMessage}`,
    };
  }
}

/**
 * Build production Docker image locally on the prod server itself and push to ECR.
 * Adds swap space if needed (t3.micro has only 1GB RAM).
 */
export async function buildProductionImageLocally(
  config: FactiiiConfig
): Promise<DeployResult> {
  const repoName = config.name ?? 'app';
  const region = config.aws?.region ?? 'us-east-1';
  const isWindows = process.platform === 'win32';
  const shellOption = isWindows ? 'cmd.exe' : '/bin/bash';

  // Get ECR registry
  let ecrRegistry: string;
  try {
    ecrRegistry = await getECRRegistry(config, _sshRootDir);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const ecrRepository = config.ecr_repository ?? repoName;
  const imageTag = ecrRegistry + '/' + ecrRepository + ':latest';

  // On Windows, build from current working directory; on Linux, use ~/.factiii/<repo>
  const repoDir = isWindows ? process.cwd() : (os.homedir() + '/.factiii/' + repoName);
  const dockerfile = isWindows ? 'apps/server/Dockerfile' : getDockerfilePath(repoDir);

  console.log('      Image: ' + imageTag);

  try {
    // Add swap space if not already present (Linux only, t3.micro has only 1GB RAM)
    if (!isWindows) {
      try {
        const swapCheck = execSync('swapon --show', { encoding: 'utf8', stdio: 'pipe' });
        if (!swapCheck.trim()) {
          console.log('   Adding 2GB swap space for Docker build...');
          execSync(
            'sudo fallocate -l 2G /swapfile && ' +
            'sudo chmod 600 /swapfile && ' +
            'sudo mkswap /swapfile && ' +
            'sudo swapon /swapfile',
            { stdio: 'inherit', shell: '/bin/bash' }
          );
          console.log('   [OK] Swap space added');
        }
      } catch { /* swap setup is best-effort */ }
    }

    // Get ECR auth token
    const { getEcrAuthToken } = await import('../aws/utils/aws-helpers.js');
    const ecrAuth = await getEcrAuthToken(region);
    if (!ecrAuth) {
      return { success: false, error: 'Failed to get ECR auth token. Check AWS credentials.' };
    }

    // Step 1: Build image
    console.log('   Building Docker image: ' + imageTag + '...');
    const buildCmd = 'docker build --platform linux/amd64 -t ' + imageTag + ' -f ' + dockerfile + ' .';
    execSync(
      isWindows ? buildCmd : ('cd ' + repoDir + ' && ' + buildCmd),
      { stdio: 'inherit', shell: shellOption, cwd: isWindows ? repoDir : undefined, env: { ...process.env, DOCKER_BUILDKIT: '1' } }
    );

    // Step 2: Login to ECR (uses AWS SDK token, no CLI needed)
    // On Windows, use default shell (cmd.exe); on Mac/Linux use bash for pipe
    console.log('   Logging in to ECR...');
    const shellOpt = isWindows ? undefined : '/bin/bash';
    execSync(
      'echo ' + JSON.stringify(ecrAuth.password) + ' | docker login --username ' + ecrAuth.username + ' --password-stdin ' + ecrRegistry,
      { stdio: 'inherit', shell: shellOpt }
    );

    // Step 3: Push to ECR
    console.log('   Pushing image to ECR: ' + imageTag + '...');
    execSync('docker push ' + imageTag, { stdio: 'inherit', shell: shellOption });

    console.log('   Production image built and pushed: ' + imageTag);
    return { success: true, message: 'Production image built and pushed: ' + imageTag };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('   Failed to build/push production image: ' + errorMessage);
    return { success: false, error: 'Failed to build/push production image: ' + errorMessage };
  }
}

// ============================================================
// Registry-less prod flow
// ============================================================
// Selected when prod has no AWS/registry configured but a staging server
// exists. Builds linux/amd64 on staging, then streams `docker save | gzip`
// from staging through the dev machine into `docker load` on prod. No ECR,
// no docker login, no push/pull. Useful for testing the prod path against
// a sandbox VM (e.g. an OrbStack instance) without breaking the real
// AWS/ECR-driven prod release flow.
// ============================================================

/**
 * Build prod image on staging and ship it directly to prod via dev relay.
 *
 * - Build target: `<config.name>:prod` (no registry prefix), linux/amd64
 * - Transfer:    ssh staging "docker save | gzip" | ssh prod "gzip -d | docker load"
 *                (bash handles the pipe; the dev machine relays bytes only)
 *
 * The dev machine needs SSH keys for *both* staging (`~/.ssh/staging_deploy_key[_repo]`)
 * and prod (`~/.ssh/prod_deploy_key[_repo]`). It does NOT require staging to
 * have any credentials for prod, which is the whole point.
 */
export async function buildAndShipProdImage(
  config: FactiiiConfig,
  stagingConfig: EnvironmentConfig,
  prodConfig: EnvironmentConfig
): Promise<DeployResult> {
  _sshStage = 'staging';
  _sshConfig = config;

  const repoName = config.name ?? 'app';
  const imageTag = repoName + ':prod';
  const repoDir = '~/.factiii/' + repoName;
  const dockerfile = 'apps/server/Dockerfile';

  const { findSshKeyForStage } = await import('../../../utils/ssh-helper.js');
  const stagingKey = findSshKeyForStage('staging', config.name);
  const prodKey = findSshKeyForStage('prod', config.name);
  if (!stagingKey) {
    return { success: false, error: 'No staging SSH key on dev machine (~/.ssh/staging_deploy_key)' };
  }
  if (!prodKey) {
    return { success: false, error: 'No prod SSH key on dev machine (~/.ssh/prod_deploy_key)' };
  }

  const stagingHost = stagingConfig.domain;
  const stagingUser = stagingConfig.ssh_user ?? 'ubuntu';
  const prodHost = prodConfig.domain;
  const prodUser = prodConfig.ssh_user ?? 'ubuntu';

  if (!stagingHost) return { success: false, error: 'staging domain not configured' };
  if (!prodHost) return { success: false, error: 'prod domain not configured' };

  console.log('   🔨 Building prod image on staging (' + stagingHost + ')');
  console.log('      Image: ' + imageTag + ' [linux/amd64]');

  try {
    // Step 1 — build amd64 image on staging with --load so it's in staging's
    // docker daemon (docker save needs it loaded, not just in buildx cache).
    await sshExecCommand(
      stagingConfig,
      'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && ' +
      'cd ' + repoDir + ' && ' +
      'docker buildx build --platform linux/amd64 --load -t ' + imageTag + ' -f ' + dockerfile + ' .'
    );

    console.log('   📦 Streaming image staging → dev → prod (gzip -1)');

    // Step 2 — pipe save→load through bash on dev. We use bash directly so
    // backpressure is handled by the kernel; node would just be a slow relay.
    const sshOpts = [
      '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'BatchMode=yes',
      '-o', 'ServerAliveInterval=15',
    ].join(' ');

    const cmd =
      'ssh ' + sshOpts + ' -i ' + stagingKey + ' ' + stagingUser + '@' + stagingHost +
      ' "docker save ' + imageTag + ' | gzip -1"' +
      ' | ' +
      'ssh ' + sshOpts + ' -i ' + prodKey + ' ' + prodUser + '@' + prodHost +
      ' "gzip -d | docker load"';

    execSync(cmd, { stdio: 'inherit', shell: '/bin/bash' });

    console.log('   ✅ Image loaded on prod: ' + imageTag);
    return { success: true, message: 'Built ' + imageTag + ' on staging and loaded on prod' };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: 'buildAndShipProdImage failed: ' + errorMessage };
  }
}

/**
 * Deploy on prod for the registry-less flow.
 *
 * Assumes the image (<config.name>:prod) is already loaded in prod's docker
 * daemon by buildAndShipProdImage. Updates the prod service's image: in the
 * existing docker-compose.yml on prod, then `docker compose up -d`. No ECR
 * login, no docker pull, no internet round-trip for image bytes.
 *
 * If no compose file exists on prod yet, we error out — generating compose
 * from scratch is a separate concern (matches deployProd's behavior).
 */
export async function deployProdPiped(
  config: FactiiiConfig,
  prodConfig: EnvironmentConfig
): Promise<DeployResult> {
  _sshStage = 'prod';
  _sshConfig = config;

  const repoName = config.name ?? 'app';
  const imageTag = repoName + ':prod';
  const serviceName = repoName + '-prod';

  if (!prodConfig.domain) {
    return { success: false, error: 'prod domain not configured' };
  }

  console.log('   🚀 Deploying to prod (' + prodConfig.domain + ', no-registry mode)');

  try {
    // Step 1 — locate compose file. Prefer ~/.factiii (managed) over ~/ (legacy).
    const composeCheck = await sshExecCommand(
      prodConfig,
      'test -f ~/.factiii/docker-compose.yml && echo FACTIII || ' +
      '(test -f ~/docker-compose.yml && echo HOME || echo MISSING)'
    );

    let composePath: string;
    if (composeCheck.includes('FACTIII')) {
      composePath = '~/.factiii/docker-compose.yml';
    } else if (composeCheck.includes('HOME')) {
      composePath = '~/docker-compose.yml';
    } else {
      return {
        success: false,
        error:
          'No docker-compose.yml on prod (~/.factiii/ or ~/). ' +
          'Seed one before running piped prod deploy — see docs.',
      };
    }

    // Step 2 — rewrite the prod service's image: to the local tag (drops any
    // build: section). We pull the file via SSH, mutate locally, write back.
    const composeContent = await sshExecCommand(prodConfig, 'cat ' + composePath);
    const compose = yaml.load(composeContent) as {
      services?: Record<string, { build?: unknown; image?: string; [key: string]: unknown }>;
      [key: string]: unknown;
    };
    if (!compose?.services?.[serviceName]) {
      return {
        success: false,
        error: 'Service "' + serviceName + '" missing from ' + composePath + ' on prod',
      };
    }
    delete compose.services[serviceName].build;
    compose.services[serviceName].image = imageTag;

    const updated = yaml.dump(compose, { lineWidth: -1 });
    await sshExecCommand(
      prodConfig,
      'cat > ' + composePath + " << 'COMPOSEEOF'\n" + updated + 'COMPOSEEOF'
    );

    // Step 3 — `up -d`. Image is already loaded; compose just starts it.
    const composeDir = composePath.replace(/\/docker-compose\.yml$/, '');
    console.log('   ▶️  docker compose up -d ' + serviceName);
    await sshExecCommand(
      prodConfig,
      'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && ' +
      'cd ' + composeDir + ' && ' +
      'docker compose up -d ' + serviceName + ' && ' +
      'sleep 3 && ' +
      'docker ps --filter name=' + repoName + ' --format "{{.Names}}: {{.Status}}"'
    );

    console.log('   ✅ Prod is up with ' + imageTag);
    return { success: true, message: 'Deployed ' + imageTag + ' to prod (no registry)' };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: 'deployProdPiped failed: ' + errorMessage };
  }
}

