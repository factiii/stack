const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { Octokit } = require('@octokit/rest');
const validate = require('./validate');

/**
 * Get GitHub owner/repo from git remote URL
 */
function getGitHubRepo() {
  try {
    const repoUrl = execSync('git config --get remote.origin.url', { encoding: 'utf8' }).trim();
    const match = repoUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (match) {
      const parts = match[1].split('/');
      return { owner: parts[0], repo: parts[1] };
    }
  } catch (e) {
    // Ignore errors
  }
  return null;
}

/**
 * Get current git branch
 */
function getCurrentBranch() {
  try {
    return execSync('git branch --show-current', { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch (e) {
    return null;
  }
}

/**
 * Deploy by validating local config and triggering GitHub workflow
 */
async function deploy(options = {}) {
  const rootDir = process.cwd();
  const configPath = path.resolve(rootDir, options.config || 'core.yml');

  console.log('🔍 Validating local repository configuration...\n');

  // Step 1: Check core.yml exists
  if (!fs.existsSync(configPath)) {
    console.error(`❌ Config file not found: ${configPath}`);
    console.error('   Run: npx core init');
    process.exit(1);
  }
  console.log('✅ Found core.yml');

  // Step 2: Validate core.yml
  console.log('🔍 Validating core.yml...');
  try {
    validate({ config: configPath });
  } catch (error) {
    console.error('❌ Config validation failed. Fix errors before deploying.\n');
    process.exit(1);
  }

  // Load config to get repo name and environments
  const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
  const repoName = config.name;

  if (!repoName) {
    console.error('❌ Config must have a "name" field');
    process.exit(1);
  }

  const environments = options.environment === 'all'
    ? Object.keys(config.environments || {})
    : [options.environment];

  if (environments.length === 0) {
    console.error('❌ No environments found in config');
    process.exit(1);
  }

  // Step 3: Check core-deploy.yml workflow exists locally
  const workflowPath = path.join(rootDir, '.github/workflows/core-deploy.yml');
  if (!fs.existsSync(workflowPath)) {
    console.error('❌ Workflow file not found: .github/workflows/core-deploy.yml');
    console.error('   Run: npx core generate-workflows');
    process.exit(1);
  }
  console.log('✅ Found core-deploy.yml workflow');

  // Step 4: Check core-undeploy.yml workflow exists locally (optional but recommended)
  const undeployWorkflowPath = path.join(rootDir, '.github/workflows/core-undeploy.yml');
  if (!fs.existsSync(undeployWorkflowPath)) {
    console.log('⚠️  Optional: core-undeploy.yml workflow not found');
    console.log('   Run: npx core generate-workflows (to add undeploy support)\n');
  } else {
    console.log('✅ Found core-undeploy.yml workflow');
  }

  // Step 5: Get GitHub token
  const token = options.token || process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('\n❌ GitHub token required to trigger workflow');
    console.error('   Set GITHUB_TOKEN environment variable or use --token option');
    console.error('   Token needs "repo" scope to trigger workflows');
    process.exit(1);
  }

  // Step 6: Get GitHub repo info
  const repoInfo = getGitHubRepo();
  if (!repoInfo) {
    console.error('\n❌ Could not detect GitHub repository');
    console.error('   Make sure you are in a git repository with a GitHub remote');
    process.exit(1);
  }

  // Step 7: Initialize GitHub API client (needed for branch detection)
  const octokit = new Octokit({ auth: token });

  // Step 8: Determine branch to deploy from
  const currentBranch = getCurrentBranch();
  let targetBranch = options.branch;

  // If no branch specified, detect the default branch from GitHub
  if (!targetBranch) {
    console.log('🔍 Detecting default branch from GitHub...');
    try {
      const { data: repo } = await octokit.rest.repos.get({
        owner: repoInfo.owner,
        repo: repoInfo.repo
      });
      targetBranch = repo.default_branch;
      console.log(`✅ Using default branch: ${targetBranch}`);
    } catch (error) {
      console.log('⚠️  Could not detect default branch, falling back to "main"');
      targetBranch = 'main';
    }
  }
  
  if (currentBranch && currentBranch !== targetBranch) {
    console.log(`\n⚠️  Note: You are on branch "${currentBranch}" but deploying from "${targetBranch}"`);
    console.log(`   To deploy from current branch, use: npx core deploy --branch ${currentBranch}\n`);
  }

  console.log(`📦 Repository: ${repoInfo.owner}/${repoInfo.repo}`);
  console.log(`🌿 Branch: ${targetBranch}`);
  console.log(`🚀 Deploying ${repoName} to: ${environments.join(', ')}\n`);

  // Step 9: Trigger GitHub workflow

  try {
    // Verify workflow exists in GitHub (checks any branch, not just target branch)
    console.log('🔍 Verifying workflow exists in GitHub...');
    try {
      const workflow = await octokit.rest.actions.getWorkflow({
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        workflow_id: 'core-deploy.yml'
      });
      console.log('✅ Workflow found in GitHub');
      
      // Note: getWorkflow finds the workflow if it exists on ANY branch
      // But workflow_dispatch only works if the workflow exists on the TARGET branch
    } catch (e) {
      if (e.status === 404) {
        const currentBranch = getCurrentBranch();
        console.error('❌ Workflow not found in GitHub repository');
        console.error('   Make sure .github/workflows/core-deploy.yml is committed and pushed');
        if (currentBranch) {
          console.error(`   Current branch: ${currentBranch}`);
          console.error('   Run: git add .github/workflows && git commit -m "Add workflows" && git push');
        }
        process.exit(1);
      }
      throw e;
    }

    // Trigger workflow
    console.log(`🚀 Triggering deploy workflow on branch: ${targetBranch}...`);
    await octokit.rest.actions.createWorkflowDispatch({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      workflow_id: 'core-deploy.yml',
      ref: targetBranch,
      inputs: {
        environment: options.environment || 'all'
      }
    });

    console.log('✅ Workflow triggered successfully!\n');

    // Step 8: Poll for workflow run status
    console.log('⏳ Waiting for workflow to start...');
    
    // Wait a moment for the workflow to be created
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Find the latest workflow run
    const { data: runs } = await octokit.rest.actions.listWorkflowRuns({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      workflow_id: 'core-deploy.yml',
      per_page: 1
    });

    if (runs.workflow_runs.length === 0) {
      console.log('⚠️  Could not find workflow run. Check GitHub Actions manually.');
      console.log(`   https://github.com/${repoInfo.owner}/${repoInfo.repo}/actions`);
      return;
    }

    const run = runs.workflow_runs[0];
    console.log(`📋 Workflow run: ${run.html_url}\n`);

    // Poll for completion
    let status = run.status;
    let conclusion = run.conclusion;
    const startTime = Date.now();
    const timeout = 10 * 60 * 1000; // 10 minutes

    while (status !== 'completed') {
      if (Date.now() - startTime > timeout) {
        console.log('\n⚠️  Timeout waiting for workflow. Check GitHub Actions:');
        console.log(`   ${run.html_url}`);
        process.exit(1);
      }

      await new Promise(resolve => setTimeout(resolve, 5000));
      
      const { data: updatedRun } = await octokit.rest.actions.getWorkflowRun({
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        run_id: run.id
      });

      status = updatedRun.status;
      conclusion = updatedRun.conclusion;

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      process.stdout.write(`\r⏳ Status: ${status}... (${elapsed}s)`);
    }

    console.log('\n');

    // Report final status
    if (conclusion === 'success') {
      console.log('✅ Deployment complete!');
      console.log('   Workflow verified configs on staging/prod servers');
      console.log('   Docker compose and nginx configurations are up to date');
    } else {
      console.error(`❌ Workflow failed with conclusion: ${conclusion}`);
      console.error(`   Check the workflow run for details: ${run.html_url}`);
      process.exit(1);
    }

  } catch (error) {
    if (error.status === 401) {
      console.error('❌ GitHub token is invalid or expired');
      console.error('   Generate a new token with "repo" scope');
    } else if (error.status === 403) {
      console.error('❌ GitHub token does not have permission to trigger workflows');
      console.error('   Ensure token has "repo" scope');
    } else if (error.status === 422) {
      // 422 errors can mean:
      // - Branch doesn't exist
      // - Workflow doesn't have workflow_dispatch
      // - Workflow doesn't exist on the target branch
      const targetBranch = options.branch || 'main';
      const currentBranch = getCurrentBranch();
      
      if (error.message.includes('No ref found') || error.message.includes('ref')) {
        console.error(`❌ Branch "${targetBranch}" does not exist in GitHub repository`);
        console.error('   The workflow needs to be triggered on an existing branch.');
        console.error('   Options:');
        console.error(`   1. Push your code to GitHub: git push -u origin ${targetBranch}`);
        if (currentBranch && currentBranch !== targetBranch) {
          console.error(`   2. Or deploy from your current branch: npx core deploy --branch ${currentBranch}`);
        }
        console.error('   3. Or change the default branch in GitHub repository settings');
      } else if (error.message.includes('workflow_dispatch') || error.message.includes('Workflow does not have')) {
        console.error(`❌ Workflow issue on branch "${targetBranch}"`);
        console.error('   Possible causes:');
        console.error('   1. The workflow file does not exist on this branch yet');
        console.error('   2. The workflow does not have workflow_dispatch trigger');
        console.error('');
        console.error('   💡 Solutions:');
        if (currentBranch && currentBranch !== targetBranch) {
          console.error(`   • Deploy from current branch: npx core deploy --branch ${currentBranch}`);
          console.error(`   • Or merge ${currentBranch} to ${targetBranch} first`);
        } else {
          console.error(`   • Push .github/workflows/core-deploy.yml to ${targetBranch}`);
          console.error('   • Or run: npx core generate-workflows && git add .github && git commit && git push');
        }
      } else {
        console.error(`❌ Failed to trigger workflow: ${error.message}`);
        console.error(`   Error status: ${error.status}`);
        if (currentBranch && currentBranch !== targetBranch) {
          console.error('');
          console.error(`   💡 Tip: You are on "${currentBranch}" but deploying from "${targetBranch}"`);
          console.error(`   Try: npx core deploy --branch ${currentBranch}`);
        }
      }
    } else {
      console.error(`❌ Failed to trigger workflow: ${error.message}`);
    }
    process.exit(1);
  }
}

module.exports = deploy;
