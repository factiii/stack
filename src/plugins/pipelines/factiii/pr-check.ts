/**
 * PR Check - Build validation for pull requests
 *
 * Runs server (Docker), client (pnpm build), and mobile (EAS) builds.
 * Used when PR opens to main - validates code builds before merge.
 *
 * Per STANDARDS: Build logic lives here, not in workflows.
 * Workflow SSHs to staging and runs: GITHUB_ACTIONS=true npx factiii pr-check --staging
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

import { getDockerfilePath } from './staging.js';
import type { FactiiiConfig } from '../../../types/index.js';

export interface BuildResult {
  name: string;
  success: boolean;
  output: string;
  duration: number;
}

export interface PRCheckResult {
  success: boolean;
  results: BuildResult[];
  sha: string;
  prNumber: number | null;
}

/**
 * Run all builds (server, client, mobile) on the current machine.
 * Call this when GITHUB_ACTIONS=true or FACTIII_ON_SERVER=true (running on staging server).
 *
 * @param rootDir - Repo root (e.g. ~/.factiii/repo-name on server)
 * @param config - factiii.yml config
 * @param options - commit, branch for git checkout
 */
export async function runBuilds(
  rootDir: string,
  config: FactiiiConfig,
  options: { commit?: string; branch?: string } = {}
): Promise<PRCheckResult> {
  const results: BuildResult[] = [];
  const sha = options.commit ?? process.env.COMMIT_HASH ?? '';
  const branch = options.branch ?? process.env.BRANCH ?? '';

  // Ensure we're on the right commit (when running on server from workflow)
  if (sha && branch) {
    try {
      execSync(`git fetch origin ${branch} 2>/dev/null || git fetch origin`, {
        cwd: rootDir,
        stdio: 'pipe',
      });
      execSync(`git checkout ${sha}`, {
        cwd: rootDir,
        stdio: 'pipe',
      });
    } catch (e) {
      console.log('   ⚠️  Could not checkout commit ' + sha + ' - using current state');
    }
  }

  const pathPrefix = process.platform === 'win32' ? '' : '/opt/homebrew/bin:/usr/local/bin:';
  const pathEnv = pathPrefix + (process.env.PATH ?? '');

  // 1. Server build (Docker)
  const serverResult = await runServerBuild(rootDir, config, pathEnv);
  results.push(serverResult);

  // 2. Client build (if client/ exists)
  const clientResult = await runClientBuild(rootDir, pathEnv);
  if (clientResult) results.push(clientResult);

  // 3. Mobile build (if docs/mobile or apps/mobile exists)
  const mobileResult = await runMobileBuild(rootDir, pathEnv);
  if (mobileResult) results.push(mobileResult);

  const success = results.every((r) => r.success);

  return {
    success,
    results,
    sha,
    prNumber: null,
  };
}

async function runServerBuild(
  rootDir: string,
  config: FactiiiConfig,
  pathEnv: string
): Promise<BuildResult> {
  const start = Date.now();
  const dockerfile = getDockerfilePath(rootDir);
  const repoName = config.name ?? 'app';
  const imageTag = `${repoName}:staging`;

  try {
    execSync(
      `cd ${rootDir} && docker build --platform linux/arm64 -t ${imageTag} -f ${dockerfile} .`,
      {
        stdio: 'pipe',
        shell: '/bin/bash',
        env: { ...process.env, PATH: pathEnv },
      }
    );
    return {
      name: 'server',
      success: true,
      output: 'Docker build succeeded',
      duration: Date.now() - start,
    };
  } catch (e: unknown) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const output = (err?.stderr?.toString() || err?.stdout?.toString() || err?.message || String(e)).trim().slice(0, 2000);
    return {
      name: 'server',
      success: false,
      output: output || 'Build failed',
      duration: Date.now() - start,
    };
  }
}

async function runClientBuild(rootDir: string, pathEnv: string): Promise<BuildResult | null> {
  const clientDir = path.join(rootDir, 'client');
  if (!fs.existsSync(clientDir)) return null;

  const pkgPath = path.join(clientDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  const start = Date.now();
  try {
    execSync('pnpm install && pnpm build', {
      cwd: clientDir,
      stdio: 'pipe',
      env: { ...process.env, PATH: pathEnv },
    });
    return {
      name: 'client',
      success: true,
      output: 'pnpm build succeeded',
      duration: Date.now() - start,
    };
  } catch (e: unknown) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const output = (err?.stderr?.toString() || err?.stdout?.toString() || err?.message || String(e)).trim().slice(0, 2000);
    return {
      name: 'client',
      success: false,
      output: output || 'Build failed',
      duration: Date.now() - start,
    };
  }
}

async function runMobileBuild(rootDir: string, pathEnv: string): Promise<BuildResult | null> {
  const mobileReadmePaths = [
    path.join(rootDir, 'docs', 'mobile', 'README.md'),
    path.join(rootDir, 'apps', 'mobile', 'README.md'),
    path.join(rootDir, 'packages', 'mobile', 'README.md'),
  ];

  let mobileDir: string | null = null;
  for (const readmePath of mobileReadmePaths) {
    if (fs.existsSync(readmePath)) {
      mobileDir = path.dirname(readmePath);
      break;
    }
  }

  if (!mobileDir) return null;

  const start = Date.now();
  try {
    // EAS build - common command; app repos can override via factiii.yml later
    execSync('npx eas build --platform all --non-interactive 2>&1 || npx eas build --platform all 2>&1', {
      cwd: mobileDir,
      stdio: 'pipe',
      env: { ...process.env, PATH: pathEnv },
      timeout: 600000, // 10 min for EAS
    });
    return {
      name: 'mobile',
      success: true,
      output: 'EAS build succeeded',
      duration: Date.now() - start,
    };
  } catch (e: unknown) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const output = (err?.stderr?.toString() || err?.stdout?.toString() || err?.message || String(e)).trim().slice(0, 2000);
    return {
      name: 'mobile',
      success: false,
      output: output || 'Build failed',
      duration: Date.now() - start,
    };
  }
}
