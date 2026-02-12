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
 * - Pipeline decides if stage runs locally or via workflow/SSH
 * - When running on server, pipeline workflow specifies --staging/--prod
 * ============================================================
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

import { scan } from './scan.js';
import { loadRelevantPlugins } from '../plugins/index.js';
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
    console.error('[!] Error parsing factiii.yml: ' + errorMessage);
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
            console.log('   [' + duration.toFixed(0) + 'ms] ' + problem.id);
          }

          if (success) {
            console.log('  [OK] Fixed: ' + problem.description);
            result.fixed++;
            result.fixes.push({
              id: problem.id,
              stage,
              status: 'fixed',
              description: problem.description,
            });
          } else {
            console.log('  [ERROR] Failed to fix: ' + problem.description);
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
          console.log('  [ERROR] Error fixing ' + problem.id + ': ' + errorMessage);
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
        console.log('  [man] Manual fix required: ' + problem.description);
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
  const pipelinePlugin = getPipelinePlugin(plugins as unknown as PluginClass[]);

  // Check reachability for each stage
  // Separate local vs remote — pipeline plugin handles remote
  const reachability: Record<string, Reachability> = {};
  const localStages: Stage[] = [];
  const remoteStages: Stage[] = [];

  for (const stage of stages) {
    if (pipelinePlugin && typeof pipelinePlugin.canReach === 'function') {
      reachability[stage] = pipelinePlugin.canReach(stage, config);

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

  // Remote stages: delegate to pipeline plugin
  if (remoteStages.length > 0) {
    const PipelineClass = pipelinePlugin as unknown as PipelinePluginClass;
    if (PipelineClass) {
      const pipeline = new PipelineClass(config);
      for (const stage of remoteStages) {
        await pipeline.fixStage(stage, {});
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
          console.log('  [OK] Fixed: ' + (fix.description || fix.id));
        } else if (fix.status === 'manual') {
          console.log('  [man] Manual: ' + (fix.description || fix.id));
          if (fix.manualFix) {
            console.log('    -> ' + fix.manualFix);
          }
        } else if (fix.status === 'failed') {
          console.log('  [ERROR] Failed: ' + (fix.description || fix.id));
          if (fix.error) {
            console.log('      Error: ' + fix.error);
          }
        }
      }
      console.log('');
    }
  }

  console.log('-'.repeat(60));
  console.log('TOTAL: Fixed: ' + result.fixed + ', Manual: ' + result.manual + ', Failed: ' + result.failed);

  // Exit with error if any fixes failed
  if (result.failed > 0) {
    process.exit(1);
  }

  return result;
}

export default fix;
