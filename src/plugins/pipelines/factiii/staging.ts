/**
 * Staging Build Utilities
 * 
 * Functions for building Docker images for staging environment:
 * - Builds linux/arm64 images on staging server (no ECR push)
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
export function getDockerfilePath(repoDir: string): string {
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
 * Ensure Docker is running before deployment
 * Starts Docker Desktop if not running and waits for it to be ready
 */
export async function ensureDockerRunning(
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
 * Build staging Docker image (linux/arm64) on staging server
 * No ECR push - builds locally and uses image tag
 * 
 * CRITICAL: This function MUST always build on the staging server, never locally.
 * When running from a local machine, it SSHs to staging and builds there.
 */
export async function buildStagingImage(
  config: FactiiiConfig,
  envConfig: EnvironmentConfig
): Promise<DeployResult> {
  const repoName = config.name ?? 'app';
  const repoDir = `~/.factiii/${repoName}`;
  const isOnServer = process.env.GITHUB_ACTIONS === 'true';

  try {
    // Ensure Docker is running
    console.log('   🐳 Checking Docker status...');
    await ensureDockerRunning(envConfig, isOnServer);

    if (isOnServer) {
      // We're on the server - run commands directly
      const expandedRepoDir = repoDir.replace('~', process.env.HOME ?? '');
      const dockerfile = getDockerfilePath(expandedRepoDir);
      const imageTag = `${repoName}:staging`;

      // Build Docker image explicitly with arm64 platform
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
    } else {
      // We're remote - SSH to the server and build there
      // CRITICAL: Build must happen on staging server, never locally
      const dockerfile = getDockerfilePath(
        path.join(process.env.HOME ?? '/Users/jon', '.factiii', repoName)
      );
      const imageTag = `${repoName}:staging`;

      // Build Docker image explicitly with arm64 platform on remote staging server
      console.log(`   🔨 Building Docker image (arm64) on staging server: ${imageTag}...`);
      console.log(`   📍 Building on: ${envConfig.host}`);
      
      await sshExec(
        envConfig,
        `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && \
         cd ${repoDir} && \
         docker build --platform linux/arm64 -t ${imageTag} -f ${dockerfile} .`
      );
      
      console.log(`   ✅ Image built successfully on staging server: ${imageTag}`);
    }

    return { success: true, message: 'Staging image built successfully' };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`   ❌ Failed to build staging image: ${errorMessage}`);
    return {
      success: false,
      error: `Failed to build staging image: ${errorMessage}`,
    };
  }
}

