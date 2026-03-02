/**
 * Fix Command
 *
 * Runs auto-fixes for detected problems.
 * For remote stages (staging/prod), delegates to pipeline plugin.
 * For local stages (dev/secrets), runs fixes directly.
 *
 * ============================================================
 * STAGE EXECUTION PATTERN
 * ============================================================
 * See scan.ts for full documentation of how stages work.
 *
 * Key points:
 * - This file asks pipeline plugin canReach(stage) for each stage
 * - Pipeline decides if stage runs locally or via SSH
 * - When running on server (FACTIII_ON_SERVER=true), runs locally
 * ============================================================
 */

import * as fs from 'fs';
import * as path from 'path';
import { scan } from './scan.js';
import { loadRelevantPlugins } from '../plugins/index.js';
import { loadConfig } from '../utils/config-helpers.js';
import type { FactiiiConfig, FixOptions, FixResult, Stage, Reachability } from '../types/index.js';

interface PluginClass {
  id: string;
  category: string;
  canReach?: (stage: Stage, config: FactiiiConfig) => Reachability;
}

/**
 * Pipeline plugin class interface (mirrors deploy.ts pattern)
 */
interface PipelinePluginClass {
  id: string;
  category: 'pipeline';
  new(config: FactiiiConfig): PipelinePluginInstance;
}

interface PipelinePluginInstance {
  fixStage(stage: Stage, options: Record<string, unknown>): Promise<{ handled: boolean }>;
}

/**
 * Get pipeline plugin from loaded plugins
 */
function getPipelinePlugin(plugins: PluginClass[]): PluginClass | undefined {
  return plugins.find((p) => p.category === 'pipeline');
}

/**
 * Get ALL pipeline plugins from loaded plugins
 */
function getAllPipelinePlugins(plugins: PluginClass[]): PluginClass[] {
  return plugins.filter((p) => p.category === 'pipeline');
}

/**
 * Check reachability across all pipeline plugins for a stage.
 * Returns the first reachable result, or the last unreachable reason.
 */
function checkReachability(
  pipelinePlugins: PluginClass[],
  stage: Stage,
  config: FactiiiConfig
): Reachability {
  let defaultPipelineReason = '';
  let lastReason = 'No pipeline plugin loaded';
  for (const plugin of pipelinePlugins) {
    if (typeof plugin.canReach === 'function') {
      const result = plugin.canReach(stage, config);
      if (result.reachable) return result;
      const reason = result.reason ?? 'Unreachable';
      if (plugin.id === (config.pipeline ?? 'factiii')) {
        defaultPipelineReason = reason;
      }
      lastReason = reason;
    }
  }
  return { reachable: false, reason: defaultPipelineReason || lastReason };
}

/**
 * Find which pipeline plugin claims a stage (first reachable).
 */
function findPipelineForStage(
  pipelinePlugins: PluginClass[],
  stage: Stage,
  config: FactiiiConfig
): PluginClass | undefined {
  for (const plugin of pipelinePlugins) {
    if (typeof plugin.canReach === 'function') {
      const result = plugin.canReach(stage, config);
      if (result.reachable) return plugin;
    }
  }
  return undefined;
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
            console.log('   [' + duration.toFixed(0) + 'ms] ' + problem.id);
          }

          if (success) {
            console.log('  ✅ Fixed: ' + problem.description);
            result.fixed++;
            result.fixes.push({
              id: problem.id,
              stage,
              status: 'fixed',
              description: problem.description,
            });
          } else {
            console.log('  ❌ Failed to fix: ' + problem.description);
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
          console.log('  ❌ Error fixing ' + problem.id + ': ' + errorMessage);
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
        console.log('  📝 Manual fix required: ' + problem.description);
        console.log('      -> ' + problem.manualFix);
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
  const pipelinePlugins = getAllPipelinePlugins(plugins as unknown as PluginClass[]);
  const pipelinePlugin = getPipelinePlugin(plugins as unknown as PluginClass[]);

  // Check reachability for each stage
  // Separate local vs remote — pipeline plugin handles remote
  const reachability: Record<string, Reachability> = {};
  const localStages: Stage[] = [];
  const remoteStages: Stage[] = [];

  for (const stage of stages) {
    if (pipelinePlugins.length > 0) {
      // Check all pipeline plugins — first reachable wins
      reachability[stage] = checkReachability(pipelinePlugins, stage, config);

      if (reachability[stage]?.reachable) {
        if (reachability[stage]!.via === 'local') {
          localStages.push(stage);
        } else {
          remoteStages.push(stage);
        }
      }
    } else {
      // No pipeline plugin or no canReach method - assume all reachable locally
      reachability[stage] = { reachable: true, via: 'local' };
      localStages.push(stage);
    }
  }

  // Run local fixes for directly reachable stages
  const result = await runLocalFixes(options, localStages);

  // Remote stages: delegate to the pipeline plugin that claims each stage
  if (remoteStages.length > 0) {
    for (const stage of remoteStages) {
      const claimingPlugin = findPipelineForStage(pipelinePlugins, stage, config);
      if (claimingPlugin) {
        const PipelineClass = claimingPlugin as unknown as PipelinePluginClass;
        const pipeline = new PipelineClass(config);
        if (typeof pipeline.fixStage === 'function') {
          await pipeline.fixStage(stage, {});
        } else {
          // Pipeline doesn't have fixStage — run fixes locally instead
          const localResult = await runLocalFixes({ ...options, stages: [stage] }, [stage]);
          result.fixed += localResult.fixed;
          result.manual += localResult.manual;
          result.failed += localResult.failed;
          result.fixes.push(...localResult.fixes);
        }
      }
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
  console.log('-'.repeat(60));
  console.log('RESULTS BY STAGE');
  console.log('-'.repeat(60) + '\n');

  const allStages: Stage[] = ['dev', 'secrets', 'staging', 'prod'];
  for (const stage of allStages) {
    const stageFixes = result.fixes.filter((f) => f.stage === stage);
    if (stageFixes.length > 0) {
      console.log(stage.toUpperCase() + ':');

      // Show each fix with its status and details
      for (const fix of stageFixes) {
        if (fix.status === 'fixed') {
          console.log('  ✅ Fixed: ' + (fix.description || fix.id));
        } else if (fix.status === 'manual') {
          console.log('  📝 Manual: ' + (fix.description || fix.id));
          if (fix.manualFix) {
            console.log('    -> ' + fix.manualFix);
          }
        } else if (fix.status === 'failed') {
          console.log('  ❌ Failed: ' + (fix.description || fix.id));
          if (fix.error) {
            console.log('      Error: ' + fix.error);
          }
        }
      }
      console.log('');
    }
  }

  console.log('-'.repeat(60));
  console.log(
    'TOTAL: ' +
      '✅ Fixed: ' +
      result.fixed +
      ', 📝 Manual: ' +
      result.manual +
      ', ❌ Failed: ' +
      result.failed
  );

  // Show next-step guidance after successful fix
  if (result.failed === 0 && result.manual === 0) {
    const hasProdStage = stages.includes('prod') || stages.includes('staging');
    if (hasProdStage) {
      console.log('');
      console.log('============================================================');
      console.log('✅ Infrastructure ready!');
      if (stages.includes('prod')) {
        console.log('   Next step:  npx stack deploy --prod');
      } else if (stages.includes('staging')) {
        console.log('   Next step:  npx stack deploy --staging');
      }
      console.log('============================================================');
    }
  } else if (result.manual > 0 && result.failed === 0) {
    console.log('');
    console.log('⚠️  Resolve manual fixes above, then re-run: npx stack fix');
  }

  // Exit with error if any fixes failed
  if (result.failed > 0) {
    process.exit(1);
  }

  return result;
}

export default fix;
