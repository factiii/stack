/**
 * PR Check Command
 *
 * Validates that server/client/mobile builds succeed before PR merge.
 * Per STANDARDS: Delegates to pipeline plugin for routing.
 *
 * Flow:
 * - When running on server (GITHUB_ACTIONS=true): runs builds, reports to GitHub
 * - When running from dev machine: SSHs to staging and runs pr-check there (if canReach=ssh)
 */

import * as fs from 'fs';
import * as path from 'path';
import { getStackConfigPath } from '../constants/config-files.js';
import { loadRelevantPlugins } from '../plugins/index.js';
import {
  reportCommitStatus,
  reportPRComment,
  getPRNumber,
} from '../utils/github-status.js';
import { runBuilds } from '../plugins/pipelines/factiii/pr-check.js';
import { extractEnvironments, loadConfig } from '../utils/config-helpers.js';
import type { FactiiiConfig, Stage } from '../types/index.js';

interface PipelinePluginClass {
  id: string;
  category: string;
  canReach: (stage: Stage, config: FactiiiConfig) => { reachable: boolean; via?: string; reason?: string };
  new (config: FactiiiConfig): PipelinePluginInstance;
}

interface PipelinePluginInstance {
  runPRCheck?: (options: PRCheckOptions) => Promise<PRCheckResult>;
}

export interface PRCheckOptions {
  rootDir?: string;
  staging?: boolean;
}

export interface PRCheckResult {
  success: boolean;
  error?: string;
}


function formatBuildReport(results: { name: string; success: boolean; output: string }[]): string {
  const lines = ['## Factiii PR Check – Build Results\n'];
  for (const r of results) {
    const icon = r.success ? '✅' : '❌';
    lines.push(`### ${icon} ${r.name}`);
    lines.push(r.success ? 'Succeeded' : '```\n' + r.output + '\n```');
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Run PR check - entry point for CLI
 */
export async function prCheck(options: PRCheckOptions = {}): Promise<PRCheckResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const config = loadConfig(rootDir);

  const environments = extractEnvironments(config);
  const stagingConfig = environments.staging;
  if (!stagingConfig?.domain) {
    console.log('\n❌ Staging not configured in config (staging.domain required)');
    return { success: false, error: 'Staging not configured' };
  }

  const plugins = await loadRelevantPlugins(rootDir, config);
  const pipelinePlugin = plugins.find((p) => p.category === 'pipeline') as PipelinePluginClass | undefined;

  if (!pipelinePlugin?.canReach) {
    console.log('\n❌ No pipeline plugin found');
    return { success: false, error: 'No pipeline plugin' };
  }

  const reach = pipelinePlugin.canReach('staging', config);

  if (!reach.reachable) {
    console.log('\n❌ Cannot reach staging: ' + reach.reason);
    return { success: false, error: reach.reason };
  }

  // On server: run builds directly and report
  if (process.env.GITHUB_ACTIONS === 'true' || process.env.FACTIII_ON_SERVER === 'true') {
    // When SSH'd from workflow, we're run with cwd=repo (workflow does: cd $REPO_DIR && npx stack pr-check)
    const repoName = config.name ?? 'app';
    const defaultRepoDir = path.join(process.env.HOME ?? '', '.factiii', repoName);
    const repoDir = fs.existsSync(getStackConfigPath(process.cwd()))
      ? process.cwd()
      : defaultRepoDir;

    if (!fs.existsSync(repoDir)) {
      console.log('\n❌ Repo not found at ' + repoDir);
      return { success: false, error: 'Repo not found' };
    }

    const sha = process.env.COMMIT_HASH ?? process.env.GITHUB_SHA ?? '';
    const prNum = getPRNumber();

    console.log('\n🔍 Running PR check builds...\n');
    await reportCommitStatus(sha, 'pending', 'Running server/client/mobile builds...', 'factiii/pr-check');

    const buildResult = await runBuilds(repoDir, config, {
      commit: sha || undefined,
      branch: process.env.BRANCH ?? process.env.GITHUB_REF_NAME,
    });

    const finalState = buildResult.success ? 'success' : 'failure';
    const desc = buildResult.success
      ? 'All builds passed'
      : 'One or more builds failed';

    await reportCommitStatus(sha, finalState, desc, 'factiii/pr-check');

    if (prNum && buildResult.results.length > 0) {
      await reportPRComment(prNum, formatBuildReport(buildResult.results));
    }

    for (const r of buildResult.results) {
      const icon = r.success ? '✅' : '❌';
      console.log(`   ${icon} ${r.name}: ${r.success ? 'OK' : r.output}`);
    }

    console.log('\n' + (buildResult.success ? '✅ All builds passed' : '❌ Build(s) failed'));
    return { success: buildResult.success };
  }

  // Dev-direct: PR check runs inside the CI workflow (GITHUB_ACTIONS=true
  // path above) or locally on dev during development. There's no server-side
  // stack CLI to remote-invoke anymore — staging is a deploy target only.
  console.log('\n⚠️  PR check runs automatically when you open a PR to main.');
  console.log('   Ensure factiii-pr-check.yml workflow is committed.');
  console.log('   To run the builds locally: GITHUB_ACTIONS=true npx stack pr-check');
  return { success: true };
}

export default prCheck;
