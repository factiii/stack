/**
 * Fix Command
 *
 * Runs auto-fixes for detected problems.
 * For remote stages (staging/prod), triggers workflows to fix on the server.
 * For local stages (dev/secrets), runs fixes directly.
 *
 * ============================================================
 * STAGE EXECUTION PATTERN
 * ============================================================
 * See scan.ts for full documentation of how stages work.
 *
 * Key points:
 * - This file asks pipeline plugin canReach(stage) for each stage
 * - Pipeline decides if stage runs locally or via workflow
 * - When running on server, pipeline workflow specifies --staging/--prod
 * ============================================================
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

import { scan } from './scan.js';
import { loadRelevantPlugins } from '../plugins/index.js';
import GitHubWorkflowMonitor from '../utils/github-workflow-monitor.js';
import { sshRemoteFactiiiCommand } from '../utils/ssh-helper.js';
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
    console.error(`[!] Error parsing factiii.yml: ${errorMessage}`);
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
        const startTime = performance.now();
        try {
          const success = await problem.fix(config, rootDir);
          const duration = performance.now() - startTime;

          // Log timing for slow fixes (> 500ms)
          if (duration > 500) {
            console.log(`   [${duration.toFixed(0)}ms] ${problem.id}`);
          }

          if (success) {
            console.log(`  [OK] Fixed: ${problem.description}`);
            result.fixed++;
            result.fixes.push({
              id: problem.id,
              stage,
              status: 'fixed',
              description: problem.description,
            });
          } else {
            console.log(`  [ERROR] Failed to fix: ${problem.description}`);
            result.failed++;
            result.fixes.push({
              id: problem.id,
              stage,
              status: 'failed',
              description: problem.description,
            });
          }
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          console.log(`  [ERROR] Error fixing ${problem.id}: ${errorMessage}`);
          result.failed++;
          result.fixes.push({
            id: problem.id,
            stage,
            status: 'failed',
            description: problem.description,
            error: errorMessage,
          });
        }
      } else {
        console.log(`  [man] Manual fix required: ${problem.description}`);
        console.log(`      → ${problem.manualFix}`);
        result.manual++;
        result.fixes.push({
          id: problem.id,
          stage,
          status: 'manual',
          description: problem.description,
          manualFix: problem.manualFix,
        });
      }
    }
  }

  return result;
}

export async function fix(options: FixOptions = {}): Promise<FixResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const config = loadConfig(rootDir);

  console.log('Running auto-fixes...\n');

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
  // Pipeline plugin decides how each stage is reached (local, ssh, workflow, or not reachable)
  const reachability: Record<string, Reachability> = {};
  const reachableStages: Stage[] = [];
  const sshStages: Stage[] = [];
  const workflowStages: Stage[] = [];

  for (const stage of stages) {
    if (pipelinePlugin && typeof pipelinePlugin.canReach === 'function') {
      reachability[stage] = pipelinePlugin.canReach(stage, config);

      // Separate stages by how they're reached
      if (reachability[stage]?.reachable) {
        if (reachability[stage]!.via === 'ssh') {
          sshStages.push(stage);
        } else if (reachability[stage]!.via === 'workflow') {
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

  // Run local fixes for directly reachable stages
  const result = await runLocalFixes(options, reachableStages);

  // Direct SSH fixes (primary path for staging/prod)
  if (sshStages.length > 0) {
    console.log('\n🔗 Running remote fixes via direct SSH...\n');

    for (const stage of sshStages) {
      console.log(`   Running ${stage} fix via SSH...`);

      try {
        const sshResult = sshRemoteFactiiiCommand(stage, config, 'fix --' + stage);

        if (sshResult.success) {
          console.log(`   ✅ ${stage} fix completed via SSH`);
        } else {
          console.log(`   ❌ ${stage} fix failed: ${sshResult.stderr}`);
          result.failed++;
          result.fixes.push({
            id: stage + '-ssh',
            stage: stage as Stage,
            status: 'failed',
            error: sshResult.stderr || 'SSH fix failed',
          });
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.log(`   ⚠️  Failed to run ${stage} fix via SSH: ${errorMessage}`);
        result.failed++;
        result.fixes.push({
          id: stage + '-ssh',
          stage: stage as Stage,
          status: 'failed',
          error: errorMessage,
        });
      }
    }
  }

  // Fallback: workflow-based fixes (only when SSH keys not available)
  if (workflowStages.length > 0) {
    console.log('\nTriggering remote fixes via GitHub Actions...\n');

    try {
      const monitor = new GitHubWorkflowMonitor();


      for (const stage of workflowStages) {
        const workflowFile = 'factiii-fix.yml';
        console.log(`   Triggering ${stage} fix...`);


        try {
          const workflowResult = await monitor.triggerAndWatch(workflowFile, stage);


          if (workflowResult.success) {
            console.log(`  [OK] ${stage} fix completed`);

            // Parse workflow output to extract fix counts
            // The workflow output contains: "Fixed: X, Manual: Y, Failed: Z"
            // We need to extract these and aggregate them
            // For now, we'll just note that the workflow completed
            // TODO: Parse workflow logs to extract actual counts
          } else {
            console.log(`  [ERROR] ${stage} fix failed: ${workflowResult.error}`);
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
          console.log(`  [!] Failed to trigger ${stage} fix: ${errorMessage}`);
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
      console.log(`\n[!] ${errorMessage}`);
      console.log('   Remote fixes require GitHub CLI. Install with: brew install gh');
    }
  }

  // ============================================================
  // CRITICAL: Display results by stage with issue details
  // ============================================================
  // This output shows WHAT was fixed and HOW to fix manual issues.
  // Users need to see the actual issues, not just counts.
  // DO NOT REMOVE THIS DETAILED OUTPUT - IT HAS BEEN DELETED 500+ TIMES
  // ============================================================
  console.log('');
  console.log('─'.repeat(60));
  console.log('RESULTS BY STAGE');
  console.log('─'.repeat(60) + '\n');

  const allStages: Stage[] = ['dev', 'secrets', 'staging', 'prod'];
  for (const stage of allStages) {
    const stageFixes = result.fixes.filter((f) => f.stage === stage);
    if (stageFixes.length > 0) {
      console.log(`${stage.toUpperCase()}:`);

      // Show each fix with its status and details
      for (const fix of stageFixes) {
        if (fix.status === 'fixed') {
          console.log(`  [OK] Fixed: ${fix.description || fix.id}`);
        } else if (fix.status === 'manual') {
          console.log(`  [man] Manual: ${fix.description || fix.id}`);
          if (fix.manualFix) {
            console.log(`    -> ${fix.manualFix}`);
          }
        } else if (fix.status === 'failed') {
          console.log(`  [ERROR] Failed: ${fix.description || fix.id}`);
          if (fix.error) {
            console.log(`      Error: ${fix.error}`);
          }
        }
      }
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

