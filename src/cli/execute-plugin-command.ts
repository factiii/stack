/**
 * Execute Plugin Command
 *
 * Executes plugin commands with proper stage routing.
 * Follows the same pattern as deploy:
 * 1. Determine target stage from --staging or --prod
 * 2. Check prodSafety - block destructive ops without --force
 * 3. Ask pipeline plugin canReach(stage)
 * 4. If via: 'workflow' -> trigger workflow
 * 5. If via: 'local' -> execute command directly
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { execSync, spawn } from 'child_process';

import type {
  FactiiiConfig,
  Stage,
  Reachability,
  PluginCommand,
  CommandResult,
} from '../types/index.js';

/**
 * Pipeline plugin class interface for commands
 */
interface PipelinePluginClass {
  id: string;
  canReach(stage: Stage, config: FactiiiConfig): Reachability;
}

/**
 * Load config from factiii.yml
 */
function loadConfig(rootDir: string): FactiiiConfig {
  const configPath = path.join(rootDir, 'factiii.yml');

  if (!fs.existsSync(configPath)) {
    return {} as FactiiiConfig;
  }

  try {
    return (yaml.load(fs.readFileSync(configPath, 'utf8')) as FactiiiConfig) ?? ({} as FactiiiConfig);
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.error('Error parsing factiii.yml: ' + errorMessage);
    return {} as FactiiiConfig;
  }
}

/**
 * Stream logs from a workflow run using gh run watch
 */
async function streamWorkflowLogs(runId: number): Promise<boolean> {
  return new Promise((resolve) => {
    const watch = spawn('gh', ['run', 'watch', runId.toString()], {
      stdio: 'inherit',
    });

    watch.on('close', (code) => {
      resolve(code === 0);
    });

    watch.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Get the final status of a workflow run
 */
function getWorkflowStatus(runId: number): { conclusion: string; url: string } {
  const result = execSync('gh run view ' + runId + ' --json conclusion,url', {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return JSON.parse(result) as { conclusion: string; url: string };
}

/**
 * Trigger a workflow to run the command remotely and stream logs
 */
async function triggerCommandWorkflow(
  command: PluginCommand,
  stage: Stage,
  options: Record<string, unknown>
): Promise<void> {
  console.log('Triggering GitHub Actions workflow for ' + command.category + ':' + command.name + '...');

  try {
    // Build the gh workflow run command with inputs
    const workflowFile = 'factiii-command.yml';
    const optionsJson = JSON.stringify(options);

    // Use gh workflow run with -f for each input field
    const cmd = 'gh workflow run "' + workflowFile + '" ' +
      '-f category="' + command.category + '" ' +
      '-f command="' + command.name + '" ' +
      '-f stage="' + stage + '" ' +
      "-f options='" + optionsJson.replace(/'/g, "'\\''") + "'";

    execSync(cmd, {
      encoding: 'utf8',
      stdio: 'pipe',
    });

    // Wait a moment for the run to be created
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Get the latest run ID for this workflow
    const runs = execSync(
      'gh run list --workflow="' + workflowFile + '" --limit=1 --json databaseId,url',
      { encoding: 'utf8', stdio: 'pipe' }
    );

    const runData = JSON.parse(runs) as Array<{ databaseId: number; url: string }>;
    if (runData.length > 0 && runData[0]) {
      const runId = runData[0].databaseId;

      console.log('');
      console.log('Monitoring workflow progress...');
      console.log('');

      // Stream logs from the workflow
      await streamWorkflowLogs(runId);

      // Get final status
      const status = getWorkflowStatus(runId);
      const isSuccess = status.conclusion === 'success';

      console.log('');
      if (isSuccess) {
        console.log('Command completed successfully!');
      } else {
        console.log('Command failed! (' + status.conclusion + ')');
        console.log('View full logs: ' + status.url);
        process.exit(1);
      }
    }
  } catch (error) {
    throw new Error(
      'Failed to trigger workflow: ' + (error instanceof Error ? error.message : String(error))
    );
  }
}

/**
 * Execute a plugin command with proper stage routing
 */
export async function executePluginCommand(
  command: PluginCommand,
  options: Record<string, unknown>,
  pipelinePlugin: PipelinePluginClass
): Promise<void> {
  const rootDir = process.cwd();
  const config = loadConfig(rootDir);

  // Determine stage from flags
  let stage: Stage | null = null;
  if (options.dev) stage = 'dev';
  if (options.staging) stage = 'staging';
  if (options.prod) stage = 'prod';

  if (!stage) {
    console.error('');
    console.error('Please specify an environment: --dev, --staging, or --prod');
    console.error('');
    console.error('Example:');
    console.error('  npx factiii ' + command.category + ' ' + command.name + ' --staging');
    console.error('');
    process.exit(1);
  }

  // Check if command supports this stage
  const supportedStages = command.stages ?? ['dev', 'staging', 'prod'];
  if (!supportedStages.includes(stage)) {
    console.error('');
    console.error('Command "' + command.name + '" does not support stage "' + stage + '"');
    console.error('Supported stages: ' + supportedStages.join(', '));
    console.error('');
    process.exit(1);
  }

  // Block destructive commands on prod without --force
  if (stage === 'prod' && command.prodSafety === 'destructive' && !options.force) {
    console.error('');
    console.error('================================================================');
    console.error('  DESTRUCTIVE COMMAND ON PRODUCTION');
    console.error('================================================================');
    console.error('');
    console.error('  The "' + command.name + '" command is destructive and may cause data loss.');
    console.error('');
    console.error('  To proceed, add the --force flag:');
    console.error('');
    console.error('    npx factiii ' + command.category + ' ' + command.name + ' --prod --force');
    console.error('');
    console.error('================================================================');
    console.error('');
    process.exit(1);
  }

  // Show caution warning for prod
  if (stage === 'prod' && command.prodSafety === 'caution') {
    console.log('');
    console.log('Running "' + command.name + '" on PRODUCTION - proceed with caution');
    console.log('');
  }

  // Check reachability (same pattern as deploy)
  const reach = pipelinePlugin.canReach(stage, config);

  if (!reach.reachable) {
    console.error('');
    console.error('Cannot reach ' + stage + ': ' + reach.reason);
    console.error('');
    process.exit(1);
  }

  if (reach.via === 'workflow') {
    // Trigger workflow to run command on server
    await triggerCommandWorkflow(command, stage, options);
    return;
  }

  // via: 'local' - execute directly
  console.log('');
  console.log('Running ' + command.category + ':' + command.name + ' on ' + stage + '...');
  console.log('');

  try {
    const result: CommandResult = await command.execute(stage, options, config, rootDir);

    if (result.success) {
      console.log('');
      console.log(result.message ?? 'Command completed successfully');
    } else {
      console.error('');
      console.error('Command failed: ' + (result.error ?? 'Unknown error'));
      process.exit(1);
    }
  } catch (error) {
    console.error('');
    console.error('Command failed: ' + (error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}
