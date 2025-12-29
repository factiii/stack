/**
 * Production Build Utilities
 * 
 * Functions for building Docker images for production environment:
 * - Builds linux/amd64 images on staging server and pushes to ECR
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
 * Get ECR registry from config or AWS account ID
 */
export function getECRRegistry(config: FactiiiConfig): string {
  const region = config.aws?.region ?? 'us-east-1';

  // Use config value if provided
  if (config.ecr_registry) {
    return config.ecr_registry;
  }

  // Construct from AWS account ID
  try {
    const accountId = execSync(
      `aws sts get-caller-identity --query Account --output text --region ${region}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
    ).trim();
    return `${accountId}.dkr.ecr.${region}.amazonaws.com`;
  } catch (error) {
    throw new Error(
      `Failed to get AWS account ID: ${error instanceof Error ? error.message : String(error)}`
    );
  }
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
      const result = await sshExec(envConfig, checkCmd);
      if (result.includes('stopped')) {
        console.log('   🐳 Starting Docker Desktop on staging server...');
        await sshExec(envConfig, startCmd);
        console.log('   ✅ Docker Desktop started');
      } else {
        console.log('   ✅ Docker is already running');
      }
    } catch {
      console.log('   🐳 Starting Docker Desktop on staging server...');
      try {
        await sshExec(envConfig, startCmd);
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
  const repoName = config.name ?? 'app';
  const region = config.aws?.region ?? 'us-east-1';

  // Get ECR registry
  let ecrRegistry: string;
  try {
    ecrRegistry = getECRRegistry(config);
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

    // Get dockerfile path
    let dockerfile: string;
    if (isOnServer) {
      const expandedRepoDir = repoDir.replace('~', process.env.HOME ?? '');
      dockerfile = getDockerfilePath(expandedRepoDir);
    } else {
      // For remote, we'll use a default and let the build command handle it
      dockerfile = 'apps/server/Dockerfile';
    }

    // Ensure Docker is running
    console.log('   🐳 Checking Docker status on staging server...');
    await ensureDockerRunning(stagingConfig, isOnServer);

    if (isOnServer) {
      // We're on the staging server - run commands directly
      const expandedRepoDir = repoDir.replace('~', process.env.HOME ?? '');

      // Step 1: Build image with amd64 platform
      console.log(`   🔨 Building Docker image (amd64): ${imageTag}...`);
      execSync(
        `cd ${expandedRepoDir} && docker build --platform linux/amd64 -t ${imageTag} -f ${dockerfile} .`,
        {
          stdio: 'inherit',
          shell: '/bin/bash',
          env: {
            ...process.env,
            PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
          },
        }
      );

      // Step 2: Login to ECR
      console.log('   🔐 Logging in to ECR...');
      execSync(
        `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${ecrRegistry}`,
        {
          stdio: 'inherit',
          shell: '/bin/bash',
          env: {
            ...process.env,
            PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
          },
        }
      );

      // Step 3: Push to ECR
      console.log(`   📤 Pushing image to ECR: ${imageTag}...`);
      execSync(`docker push ${imageTag}`, {
        stdio: 'inherit',
        shell: '/bin/bash',
        env: {
          ...process.env,
          PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
        },
      });
    } else {
      // We're remote - SSH to staging server
      await sshExec(
        stagingConfig,
        `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && \
         cd ${repoDir} && \
         dockerfile="${dockerfile}" && \
         echo "🔨 Building Docker image (amd64): ${imageTag}..." && \
         docker build --platform linux/amd64 -t ${imageTag} -f "\$dockerfile" . && \
         echo "🔐 Logging in to ECR..." && \
         aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${ecrRegistry} && \
         echo "📤 Pushing image to ECR: ${imageTag}..." && \
         docker push ${imageTag}`
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

