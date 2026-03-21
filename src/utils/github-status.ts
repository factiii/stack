/**
 * GitHub Status Reporting Utility
 *
 * Reports commit statuses and PR comments for CI/CD (e.g. pr-check).
 * Uses Octokit (already a dependency) for GitHub API.
 *
 * Auth: GITHUB_TOKEN environment variable
 */

import * as fs from 'fs';
import { Octokit } from '@octokit/rest';
import { execSync } from 'child_process';
import { getRepoInfo as _getRepoInfo } from './git-repo-info.js';
export type { RepoInfo } from './git-repo-info.js';

export type CommitStatusState = 'pending' | 'success' | 'failure' | 'error';

/**
 * Get repo info from git remote
 */
export function getRepoInfo() {
  return _getRepoInfo();
}

/**
 * Report commit status to GitHub (appears on PR/commit in GitHub UI)
 *
 * @param sha - Commit SHA
 * @param state - pending | success | failure | error
 * @param description - Short status description
 * @param context - Status context (e.g. 'factiii/pr-check', 'factiii/server-build')
 */
export async function reportCommitStatus(
  sha: string,
  state: CommitStatusState,
  description: string,
  context: string = 'factiii/pr-check'
): Promise<boolean> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.log('   ⚠️  GITHUB_TOKEN not set - cannot report status to GitHub');
    return false;
  }

  const repoInfo = getRepoInfo();
  if (!repoInfo) {
    console.log('   ⚠️  Could not determine GitHub repo - cannot report status');
    return false;
  }

  try {
    const octokit = new Octokit({ auth: token });
    await octokit.rest.repos.createCommitStatus({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      sha,
      state,
      description,
      context,
    });
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log('   ⚠️  Failed to report status: ' + msg);
    return false;
  }
}

/**
 * Post a comment on a pull request
 *
 * @param prNumber - Pull request number
 * @param body - Comment body (Markdown)
 */
export async function reportPRComment(prNumber: number, body: string): Promise<boolean> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.log('   ⚠️  GITHUB_TOKEN not set - cannot post PR comment');
    return false;
  }

  const repoInfo = getRepoInfo();
  if (!repoInfo) {
    console.log('   ⚠️  Could not determine GitHub repo - cannot post comment');
    return false;
  }

  try {
    const octokit = new Octokit({ auth: token });
    await octokit.rest.issues.createComment({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      issue_number: prNumber,
      body,
    });
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log('   ⚠️  Failed to post PR comment: ' + msg);
    return false;
  }
}

/**
 * Get current PR number from environment (when running in GitHub Actions)
 * or from gh CLI
 */
export function getPRNumber(): number | null {
  // Passed explicitly by workflow (e.g. PR_NUMBER when SSH'd to server)
  const prNum = process.env.PR_NUMBER;
  if (prNum) {
    const n = parseInt(prNum, 10);
    if (!isNaN(n)) return n;
  }

  // GitHub Actions: refs/pull/123/merge
  const ghPr = process.env.GITHUB_REF;
  if (ghPr) {
    const match = ghPr.match(/refs\/pull\/(\d+)\/merge/);
    const num = match?.[1];
    if (num) return parseInt(num, 10);
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath) {
    try {
      const event = fs.readFileSync(eventPath, 'utf8');
      const parsed = JSON.parse(event);
      return parsed.pull_request?.number ?? null;
    } catch {
      // Ignore
    }
  }

  // Try gh CLI
  try {
    const out = execSync('gh pr view --json number 2>/dev/null || true', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(out);
    return parsed.number ?? null;
  } catch {
    return null;
  }
}
