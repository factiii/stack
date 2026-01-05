/**
 * Workflow Generation and Triggering Utilities
 * 
 * Static methods for managing GitHub Actions workflows:
 * - Generate workflow files from templates
 * - Trigger workflows via GitHub API
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { Octokit } from '@octokit/rest';
import { GitHubSecretsStore } from '../github-secrets-store.js';
import { getFactiiiVersion } from '../../../../utils/version-check.js';

/**
 * Generate GitHub workflow files in the target repository
 */
export async function generateWorkflows(rootDir: string): Promise<void> {
  const workflowsDir = path.join(rootDir, '.github', 'workflows');
  const sourceDir = path.join(__dirname, '../workflows');

  // Get package version
  const version = getFactiiiVersion();

  // Create .github/workflows if it doesn't exist
  if (!fs.existsSync(workflowsDir)) {
    fs.mkdirSync(workflowsDir, { recursive: true });
  }

  // Copy workflow files and inject version
  // Infrastructure management (manual dispatch):
  //   - factiii-deploy.yml: Manual deploy with --staging or --prod
  //   - factiii-fix.yml: Manual fix with matrix for all configured envs
  //   - factiii-scan.yml: Manual scan with matrix for all configured envs
  //   - factiii-undeploy.yml: Manual cleanup
  // CI/CD (auto on push):
  //   - factiii-cicd-staging.yml: Auto-deploy on push to main
  //   - factiii-cicd-prod.yml: Auto-deploy on push to prod
  const workflows = [
    'factiii-deploy.yml',
    'factiii-fix.yml',
    'factiii-scan.yml',
    'factiii-undeploy.yml',
    'factiii-cicd-staging.yml',
    'factiii-cicd-prod.yml',
    'factiii-command.yml',
  ];

  // Only add dev-sync workflow in dev mode
  if (process.env.DEV_MODE === 'true') {
    workflows.push('factiii-dev-sync.yml');
  }

  for (const workflow of workflows) {
    const sourcePath = path.join(sourceDir, workflow);
    const destPath = path.join(workflowsDir, workflow);

    if (fs.existsSync(sourcePath)) {
      let content = fs.readFileSync(sourcePath, 'utf8');

      // Replace version placeholder with actual version
      content = content.replace(/v\{VERSION\}/g, `v${version}`);

      fs.writeFileSync(destPath, content);
      console.log(`   ✅ Generated ${workflow}`);
    }
  }
}

/**
 * Trigger a GitHub Actions workflow
 */
export async function triggerWorkflow(
  workflowName: string,
  inputs: Record<string, string> = {}
): Promise<void> {
  const repoInfo = GitHubSecretsStore.getRepoInfo();

  if (!repoInfo) {
    throw new Error('Could not determine GitHub repository');
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN required to trigger workflows');
  }

  // Get current branch
  let ref = 'main';
  try {
    ref = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Fall back to main if we can't detect the branch
  }

  const octokit = new Octokit({ auth: token });

  await octokit.rest.actions.createWorkflowDispatch({
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    workflow_id: workflowName,
    ref,
    inputs,
  });
}

