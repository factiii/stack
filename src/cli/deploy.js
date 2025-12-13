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

  console.log(`\n📦 Repository: ${repoInfo.owner}/${repoInfo.repo}`);
  console.log(`🚀 Deploying ${repoName} to: ${environments.join(', ')}\n`);

  // Step 7: Trigger GitHub workflow
  const octokit = new Octokit({ auth: token });

  try {
    // Verify workflow exists in GitHub
    console.log('🔍 Verifying workflow exists in GitHub...');
    try {
      await octokit.rest.actions.getWorkflow({
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        workflow_id: 'core-deploy.yml'
      });
      console.log('✅ Workflow found in GitHub');
    } catch (e) {
      if (e.status === 404) {
        console.error('❌ Workflow not found in GitHub repository');
        console.error('   Make sure .github/workflows/core-deploy.yml is committed and pushed');
        process.exit(1);
      }
      throw e;
    }

    // Trigger workflow
    console.log('🚀 Triggering deploy workflow...');
    await octokit.rest.actions.createWorkflowDispatch({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      workflow_id: 'deploy.yml',
      ref: 'main',
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
      workflow_id: 'deploy.yml',
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
    } else {
      console.error(`❌ Failed to trigger workflow: ${error.message}`);
    }
    process.exit(1);
  }
}

module.exports = deploy;
