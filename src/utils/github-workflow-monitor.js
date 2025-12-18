/**
 * GitHub Workflow Monitor
 * 
 * Utility for triggering GitHub Actions workflows and monitoring their progress.
 * Uses GitHub CLI (gh) for authentication and API access.
 */
const { execSync, spawn } = require('child_process');

class GitHubWorkflowMonitor {
  constructor() {
    this.checkGhCli();
  }

  /**
   * Check if GitHub CLI is installed and authenticated
   */
  checkGhCli() {
    try {
      execSync('which gh', { stdio: 'pipe' });
      
      // Check if authenticated
      const authStatus = execSync('gh auth status', { 
        stdio: 'pipe',
        encoding: 'utf8' 
      });
      
      if (!authStatus.includes('Logged in')) {
        throw new Error('GitHub CLI not authenticated. Run: gh auth login');
      }
    } catch (error) {
      throw new Error('GitHub CLI not available. Install with: brew install gh');
    }
  }

  /**
   * Trigger a workflow and return the run ID
   */
  async triggerWorkflow(workflowFile, environment) {
    try {
      console.log(`🚀 Triggering GitHub Actions workflow...`);
      
      // Trigger the workflow
      const result = execSync(
        `gh workflow run "${workflowFile}" -f environment="${environment}"`,
        { encoding: 'utf8', stdio: 'pipe' }
      );
      
      // Wait a moment for the run to be created
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Get the latest run ID for this workflow
      const runs = execSync(
        `gh run list --workflow="${workflowFile}" --limit=1 --json databaseId,status,conclusion`,
        { encoding: 'utf8', stdio: 'pipe' }
      );
      
      const runData = JSON.parse(runs);
      if (runData.length === 0) {
        throw new Error('Failed to find triggered workflow run');
      }
      
      return runData[0].databaseId;
    } catch (error) {
      throw new Error(`Failed to trigger workflow: ${error.message}`);
    }
  }

  /**
   * Stream logs from a workflow run
   */
  async streamLogs(runId) {
    return new Promise((resolve, reject) => {
      console.log(`📡 Monitoring deployment progress...\n`);
      
      // Use gh run watch to stream logs
      const watch = spawn('gh', ['run', 'watch', runId.toString()], {
        stdio: 'inherit'
      });
      
      watch.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true });
        } else {
          resolve({ success: false, exitCode: code });
        }
      });
      
      watch.on('error', (error) => {
        reject(new Error(`Failed to watch workflow: ${error.message}`));
      });
    });
  }

  /**
   * Get the status of a workflow run
   */
  async getRunStatus(runId) {
    try {
      const result = execSync(
        `gh run view ${runId} --json status,conclusion,url`,
        { encoding: 'utf8', stdio: 'pipe' }
      );
      
      return JSON.parse(result);
    } catch (error) {
      throw new Error(`Failed to get run status: ${error.message}`);
    }
  }

  /**
   * Trigger a workflow and wait for completion with live logs
   */
  async triggerAndWatch(workflowFile, environment) {
    try {
      // Trigger the workflow
      const runId = await this.triggerWorkflow(workflowFile, environment);
      
      // Stream logs
      const result = await this.streamLogs(runId);
      
      // Get final status
      const status = await this.getRunStatus(runId);
      
      console.log('');
      if (result.success) {
        console.log(`✅ Deployment successful!`);
        console.log(`   View full logs: ${status.url}`);
      } else {
        console.log(`❌ Deployment failed!`);
        console.log(`   View full logs: ${status.url}`);
      }
      
      return {
        success: result.success,
        url: status.url,
        runId
      };
    } catch (error) {
      console.error(`\n❌ Error: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = GitHubWorkflowMonitor;
