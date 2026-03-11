/**
 * Git Repository Info Utility
 *
 * Parses GitHub owner/repo from git remote origin URL.
 * Extracted from GitHubSecretsStore (now removed).
 */

import { execSync } from 'child_process';

export interface RepoInfo {
  owner: string;
  repo: string;
}

/**
 * Get repository info from git remote
 */
export function getRepoInfo(): RepoInfo | null {
  try {
    const remote = execSync('git config --get remote.origin.url', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();

    // Parse GitHub URL (supports both HTTPS and SSH)
    const match = remote.match(/github\.com[:/]([^/]+)\/(.+?)(\.git)?$/);

    if (match && match[1] && match[2]) {
      return {
        owner: match[1],
        repo: match[2],
      };
    }

    return null;
  } catch {
    return null;
  }
}
