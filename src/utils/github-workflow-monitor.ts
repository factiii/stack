/**
 * GitHub Workflow Monitor
 *
 * Utility for triggering GitHub Actions workflows and monitoring their progress.
 * Uses GitHub CLI (gh) for authentication and API access.
 */

import { execSync, spawn } from 'child_process';

interface WorkflowRunStatus {
  status: string;
  conclusion: string;
  url: string;
}

interface TriggerAndWatchResult {
  success: boolean;
  url?: string;
  runId?: number;
  error?: string;
}

interface StreamLogsResult {
  success: boolean;
  exitCode?: number;
}

class GitHubWorkflowMonitor {
  constructor() {
    this.checkGhCli();
  }

  /**
   * Check if GitHub CLI is installed and authenticated
   */
  private checkGhCli(): void {
    try {
      execSync('which gh', { stdio: 'pipe' });

      // Check if authenticated
      const authStatus = execSync('gh auth status', {
        stdio: 'pipe',
        encoding: 'utf8',
      });

      if (!authStatus.includes('Logged in')) {
        throw new Error('GitHub CLI not authenticated. Run: gh auth login');
      }
    } catch {
      throw new Error('GitHub CLI not available. Install with: brew install gh');
    }
  }

  /**
   * Trigger a workflow and return the run ID
   * 
   * @param workflowFile - The workflow file name (e.g., 'factiii-scan-staging.yml')
   * @param environment - Optional environment name (only used for workflows that accept inputs)
   */
  async triggerWorkflow(workflowFile: string, environment?: string): Promise<number> {
    try {
      console.log(`🚀 Triggering GitHub Actions workflow...`);

      // Build command - add environment input for workflows that accept it
      let command = `gh workflow run "${workflowFile}"`;
      
      // Add environment input for workflows that accept it (deploy, fix, scan)
      if (environment && (workflowFile.includes('deploy') || workflowFile.includes('fix') || workflowFile.includes('scan'))) {
        command += ` -f environment="${environment}"`;
      }

      // Trigger the workflow
      execSync(command, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      // Wait a moment for the run to be created
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Get the latest run ID for this workflow
      const runs = execSync(
        `gh run list --workflow="${workflowFile}" --limit=1 --json databaseId,status,conclusion`,
        { encoding: 'utf8', stdio: 'pipe' }
      );

      const runData = JSON.parse(runs) as Array<{ databaseId: number }>;
      if (runData.length === 0) {
        throw new Error('Failed to find triggered workflow run');
      }

      const firstRun = runData[0];
      if (!firstRun) {
        throw new Error('Failed to find triggered workflow run');
      }

      return firstRun.databaseId;
    } catch (error) {
      throw new Error(
        `Failed to trigger workflow: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Stream logs from a workflow run
   */
  async streamLogs(runId: number): Promise<StreamLogsResult> {
    return new Promise((resolve, reject) => {
      console.log(`📡 Monitoring deployment progress...\n`);

      // Use gh run watch to stream logs
      const watch = spawn('gh', ['run', 'watch', runId.toString()], {
        stdio: 'inherit',
      });

      watch.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true });
        } else {
          resolve({ success: false, exitCode: code ?? undefined });
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
  async getRunStatus(runId: number): Promise<WorkflowRunStatus> {
    try {
      const result = execSync(`gh run view ${runId} --json status,conclusion,url`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      return JSON.parse(result) as WorkflowRunStatus;
    } catch (error) {
      throw new Error(
        `Failed to get run status: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Trigger a workflow and wait for completion with live logs
   */
  async triggerAndWatch(
    workflowFile: string,
    environment?: string
  ): Promise<TriggerAndWatchResult> {
    try {
      // Trigger the workflow
      const runId = await this.triggerWorkflow(workflowFile, environment);

      // Stream logs (just for display - gh run watch exits 0 regardless of workflow result)
      await this.streamLogs(runId);

      // Get final status - THIS determines actual success based on workflow conclusion
      const status = await this.getRunStatus(runId);
      const isSuccess = status.conclusion === 'success';

      console.log('');
      if (isSuccess) {
        console.log(`✅ Deployment successful!`);
      } else {
        console.log(`❌ Deployment failed! (${status.conclusion})`);
      }
      console.log(`   View full logs: ${status.url}`);

      return {
        success: isSuccess,
        url: status.url,
        runId,
      };
    } catch (error) {
      console.error(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}`);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export default GitHubWorkflowMonitor;

