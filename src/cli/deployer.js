const { execSync } = require('child_process');
const { Octokit } = require('@octokit/rest');

/**
 * Workflow-based deployer - triggers GitHub Actions workflows
 * Workflows have access to GitHub Secrets and perform actual deployment
 */
class Deployer {
  constructor(config, options = {}) {
    this.config = config;
    this.options = options;
    this.rootDir = process.cwd();
  }

  /**
   * Main deployment method - triggers workflows for environments
   */
  async deploy(environments = ['all']) {
    const results = [];
    
    // If 'all', deploy to all environments
    if (environments.includes('all')) {
      environments = Object.keys(this.config.environments || {});
    }

    if (environments.length === 0) {
      throw new Error('No environments found to deploy');
    }

    console.log(`🚀 Deploying to: ${environments.join(', ')}\n`);

    for (const envName of environments) {
      console.log(`${'='.repeat(70)}`);
      console.log(`📦 Deploying to ${envName}`);
      console.log(`${'='.repeat(70)}\n`);

      try {
        const result = await this.triggerWorkflowAndWait(envName);
        results.push({ environment: envName, ...result });
        
        if (result.success) {
          console.log(`\n✅ Successfully deployed to ${envName}\n`);
        } else {
          console.error(`\n❌ Failed to deploy to ${envName}: ${result.error}\n`);
        }
      } catch (error) {
        console.error(`\n❌ Deployment error for ${envName}: ${error.message}\n`);
        results.push({
          environment: envName,
          success: false,
          error: error.message
        });
      }
    }

    return results;
  }

  /**
   * Trigger GitHub Actions workflow and wait for completion
   */
  async triggerWorkflowAndWait(envName) {
    // Get GitHub token
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error(
        'GITHUB_TOKEN required to trigger deployment.\n' +
        '\n' +
        '   Generate token: https://github.com/settings/tokens\n' +
        '   → Select scopes: repo + workflow\n' +
        '\n' +
        '   Add to your shell config:\n' +
        '   export GITHUB_TOKEN=ghp_your_token_here\n'
      );
    }

    // Get repo info
    const repoInfo = this.getRepoInfo();
    if (!repoInfo) {
      throw new Error('Could not determine GitHub repository');
    }

    const [owner, repo] = repoInfo.split('/');
    
    // Get current branch
    const branch = execSync('git branch --show-current', { 
      encoding: 'utf8',
      stdio: 'pipe'
    }).trim();

    console.log(`   📍 Repository: ${owner}/${repo}`);
    console.log(`   🌿 Branch: ${branch}`);
    console.log(`   🎯 Environment: ${envName}\n`);

    // Initialize Octokit
    const octokit = new Octokit({ auth: token });

    // Trigger workflow
    console.log('   🔍 Verifying workflow exists in GitHub...');
    
    try {
      await octokit.actions.getWorkflow({
        owner,
        repo,
        workflow_id: 'core-deploy.yml'
      });
      console.log('   ✅ Workflow found in GitHub\n');
    } catch (error) {
      if (error.status === 404) {
        throw new Error(
          'Workflow not found: .github/workflows/core-deploy.yml\n' +
          '\n' +
          '   Run: npx core generate-workflows\n' +
          '   Then commit and push: git add .github/workflows && git commit && git push\n'
        );
      }
      throw error;
    }

    console.log(`   🚀 Triggering deploy workflow on branch: ${branch}...`);
    
    try {
      await octokit.actions.createWorkflowDispatch({
        owner,
        repo,
        workflow_id: 'core-deploy.yml',
        ref: branch,
        inputs: {
          environment: envName
        }
      });
    } catch (error) {
      if (error.status === 422) {
        throw new Error(
          `Cannot trigger workflow on branch '${branch}'.\n` +
          '\n' +
          '   The workflow file must exist on this branch.\n' +
          '   Commit and push .github/workflows/core-deploy.yml first.\n'
        );
      }
      throw new Error(`Failed to trigger workflow: ${error.message}`);
    }

    console.log('   ✅ Workflow triggered successfully!\n');
    console.log('   ⏳ Waiting for workflow to start...');

    // Wait for workflow run to appear (can take a few seconds)
    let workflowRun = null;
    const maxWaitTime = 30000; // 30 seconds
    const startTime = Date.now();

    while (!workflowRun && (Date.now() - startTime < maxWaitTime)) {
      await this.sleep(2000); // Wait 2 seconds between checks

      try {
        const runs = await octokit.actions.listWorkflowRuns({
          owner,
          repo,
          workflow_id: 'core-deploy.yml',
          branch,
          per_page: 5
        });

        // Find the most recent run (should be ours)
        if (runs.data.workflow_runs.length > 0) {
          workflowRun = runs.data.workflow_runs[0];
        }
      } catch (error) {
        // Ignore errors while polling
      }
    }

    if (!workflowRun) {
      throw new Error('Workflow run did not start within 30 seconds');
    }

    console.log(`   📋 Workflow run: ${workflowRun.html_url}`);
    console.log('');

    // Poll for workflow completion
    let status = workflowRun.status;
    let conclusion = workflowRun.conclusion;
    let lastStatus = '';

    while (status !== 'completed') {
      await this.sleep(5000); // Check every 5 seconds

      try {
        const run = await octokit.actions.getWorkflowRun({
          owner,
          repo,
          run_id: workflowRun.id
        });

        status = run.data.status;
        conclusion = run.data.conclusion;

        // Show status updates
        if (status !== lastStatus) {
          const elapsed = Math.floor((Date.now() - startTime) / 1000);
          console.log(`   ⏳ Status: ${status}... (${elapsed}s)`);
          lastStatus = status;
        }
      } catch (error) {
        // Ignore polling errors
      }
    }

    console.log('');

    // Check conclusion
    if (conclusion === 'success') {
      console.log('   ✅ Workflow completed successfully!');
      return {
        success: true,
        message: 'Deployment completed via GitHub Actions',
        url: workflowRun.html_url
      };
    } else {
      console.error(`   ❌ Workflow failed with conclusion: ${conclusion}`);
      console.error(`   Check the workflow run for details: ${workflowRun.html_url}`);
      return {
        success: false,
        error: `Workflow ${conclusion}`,
        url: workflowRun.html_url
      };
    }
  }

  /**
   * Get GitHub repository info from git remote
   */
  getRepoInfo() {
    try {
      const repoUrl = execSync('git config --get remote.origin.url', { 
        encoding: 'utf8',
        stdio: 'pipe'
      }).trim();
      
      const match = repoUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
      return match ? match[1] : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = Deployer;
