/**
 * Fix Command
 *
 * Runs auto-fixes for detected problems.
 * For remote stages (staging/prod), triggers workflows to fix on the server.
 * For local stages (dev/secrets), runs fixes directly.
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

import { scan } from './scan.js';
import { loadRelevantPlugins } from '../plugins/index.js';
import GitHubWorkflowMonitor from '../utils/github-workflow-monitor.js';
import type { FactiiiConfig, FixOptions, FixResult, Stage, Reachability } from '../types/index.js';

interface PluginClass {
  id: string;
  category: string;
  canReach?: (stage: Stage, config: FactiiiConfig) => Reachability;
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
    console.error(`⚠️  Error parsing factiii.yml: ${errorMessage}`);
    return {} as FactiiiConfig;
  }
}

/**
 * Get pipeline plugin from loaded plugins
 */
function getPipelinePlugin(plugins: PluginClass[]): PluginClass | undefined {
  return plugins.find((p) => p.category === 'pipeline');
}

/**
 * Run fixes locally for reachable stages
 */
async function runLocalFixes(
  options: FixOptions,
  reachableStages: Stage[]
): Promise<FixResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const config = loadConfig(rootDir);

  // First run scan to get problems (only for reachable stages)
  const problems = await scan({ 
    ...options, 
    silent: true,
    stages: reachableStages,
    onServer: options.onServer 
  });

  const result: FixResult = {
    fixed: 0,
    manual: 0,
    failed: 0,
    fixes: [],
  };

  // Run fixes for reachable stages only
  for (const stage of reachableStages) {
    const stageProblems = problems[stage] ?? [];

    for (const problem of stageProblems) {
      if (problem.fix) {
        try {
          const success = await problem.fix(config, rootDir);
          if (success) {
            console.log(`   ✅ Fixed: ${problem.description}`);
            result.fixed++;
            result.fixes.push({ id: problem.id, stage, status: 'fixed' });
          } else {
            console.log(`   ❌ Failed to fix: ${problem.description}`);
            result.failed++;
            result.fixes.push({ id: problem.id, stage, status: 'failed' });
          }
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          console.log(`   ❌ Error fixing ${problem.id}: ${errorMessage}`);
          result.failed++;
          result.fixes.push({ id: problem.id, stage, status: 'failed', error: errorMessage });
        }
      } else {
        console.log(`   📝 Manual fix required: ${problem.description}`);
        console.log(`      ${problem.manualFix}`);
        result.manual++;
        result.fixes.push({ id: problem.id, stage, status: 'manual' });
      }
    }
  }

  return result;
}

export async function fix(options: FixOptions = {}): Promise<FixResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const config = loadConfig(rootDir);

  console.log('🔧 Running auto-fixes...\n');

  // Determine which stages to fix
  let stages: Stage[] = ['dev', 'secrets', 'staging', 'prod'];
  if (options.dev) stages = ['dev'];
  else if (options.secrets) stages = ['secrets'];
  else if (options.staging) stages = ['staging'];
  else if (options.prod) stages = ['prod'];
  else if (options.stages) stages = options.stages;

  // Load all plugins to check reachability
  const plugins = await loadRelevantPlugins(rootDir, config);
  const pipelinePlugin = getPipelinePlugin(plugins as unknown as PluginClass[]);

  // Check reachability for each stage
  const reachability: Record<string, Reachability> = {};
  const reachableStages: Stage[] = [];
  const workflowStages: Stage[] = [];

  // ============================================================
  // CRITICAL: --on-server flag bypasses canReach checks
  // ============================================================
  // SSH keys for staging/prod are ONLY in GitHub Secrets, NOT on dev machines.
  // Dev machine CANNOT SSH to staging/prod directly.
  // 
  // Why this exists: When workflows SSH to staging/prod and run commands,
  // we're already on the target server. canReach() would try to SSH again
  // causing connection loops and failures.
  // 
  // What breaks if changed: Fix from staging/prod server tries to SSH
  // back to itself, causing "Connection refused" or infinite loops.
  // 
  // Dependencies: Workflows MUST use --on-server flag when running commands
  // on staging/prod servers.
  // ============================================================
  if (options.onServer) {
    // Skip canReach checks - we're already on the target server
    for (const stage of stages) {
      reachability[stage] = { reachable: true, via: 'local' };
      reachableStages.push(stage);
    }
  } else {
    // Normal canReach checks
    for (const stage of stages) {
      if (pipelinePlugin && typeof pipelinePlugin.canReach === 'function') {
        reachability[stage] = pipelinePlugin.canReach(stage, config);

        // Separate stages by how they're reached
        if (reachability[stage]?.reachable) {
          if (reachability[stage]!.via === 'workflow') {
            workflowStages.push(stage);
          } else {
            reachableStages.push(stage);
          }
        }
      } else {
        // No pipeline plugin or no canReach method - assume all reachable locally
        reachability[stage] = { reachable: true, via: 'local' };
        reachableStages.push(stage);
      }
    }
  }

  // Run local fixes for directly reachable stages
  const result = await runLocalFixes(options, reachableStages);

  // Trigger workflows for stages reachable via workflow
  if (workflowStages.length > 0) {
    console.log('\n🔄 Triggering remote fixes via GitHub Actions...\n');
    
    try {
      const monitor = new GitHubWorkflowMonitor();
      
      for (const stage of workflowStages) {
        const workflowFile = `factiii-fix-${stage}.yml`;
        console.log(`   Triggering ${stage} fix...`);
        
        try {
          // Use triggerAndWatch to wait for workflow completion
          const workflowResult = await monitor.triggerAndWatch(workflowFile, stage);
          
          if (workflowResult.success) {
            console.log(`   ✅ ${stage} fix completed`);
            
            // Parse workflow output to extract fix counts
            // The workflow output contains: "Fixed: X, Manual: Y, Failed: Z"
            // We need to extract these and aggregate them
            // For now, we'll just note that the workflow completed
            // TODO: Parse workflow logs to extract actual counts
          } else {
            console.log(`   ❌ ${stage} fix failed: ${workflowResult.error}`);
            result.failed++;
            result.fixes.push({
              id: `${stage}-workflow`,
              stage: stage as Stage,
              status: 'failed',
              error: workflowResult.error,
            });
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.log(`   ⚠️  Failed to trigger ${stage} fix: ${errorMessage}`);
          result.failed++;
          result.fixes.push({
            id: `${stage}-workflow`,
            stage: stage as Stage,
            status: 'failed',
            error: errorMessage,
          });
        }
      }
    } catch (error) {
      // GitHub CLI not available - show helpful message
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log(`\n⚠️  ${errorMessage}`);
      console.log('   Remote fixes require GitHub CLI. Install with: brew install gh');
    }
  }

  // Display results by stage
  console.log('');
  console.log('─'.repeat(60));
  console.log('RESULTS BY STAGE');
  console.log('─'.repeat(60) + '\n');

  const allStages: Stage[] = ['dev', 'secrets', 'staging', 'prod'];
  for (const stage of allStages) {
    const stageFixes = result.fixes.filter((f) => f.stage === stage);
    if (stageFixes.length > 0) {
      const stageFixed = stageFixes.filter((f) => f.status === 'fixed').length;
      const stageManual = stageFixes.filter((f) => f.status === 'manual').length;
      const stageFailed = stageFixes.filter((f) => f.status === 'failed').length;
      
      console.log(`${stage.toUpperCase()}:`);
      console.log(`   Fixed: ${stageFixed}, Manual: ${stageManual}, Failed: ${stageFailed}`);
      console.log('');
    }
  }

  console.log('─'.repeat(60));
  console.log(`TOTAL: Fixed: ${result.fixed}, Manual: ${result.manual}, Failed: ${result.failed}`);

  // Exit with error if any fixes failed
  if (result.failed > 0) {
    process.exit(1);
  }

  return result;
}

export default fix;

