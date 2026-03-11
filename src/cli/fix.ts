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
import { loadConfig, isDevOnly } from '../utils/config-helpers.js';
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
 * Run fixes locally for reachable stages.
 *
 * Uses multi-pass execution: after running fixes for a stage, if any
 * succeeded, re-scans to find newly-unblocked fixes. This handles
 * dependency chains (e.g., vault password → vault file → store secrets
 * → create SSH key) in a single `npx stack fix` run.
 *
 * Max 3 iterations per stage to prevent infinite loops.
 */
async function runLocalFixes(
  options: FixOptions,
  reachableStages: Stage[]
): Promise<FixResult> {
  const rootDir = options.rootDir ?? process.cwd();

  const result: FixResult = {
    fixed: 0,
    manual: 0,
    failed: 0,
    fixes: [],
  };

  // Track IDs that have been processed (fixed, failed, or manual) to avoid re-running
  const processedIds = new Set<string>();

  // Run fixes for reachable stages only
  for (const stage of reachableStages) {
    let iteration = 0;
    const maxIterations = 3;
    let stageHeaderShown = false;

    while (iteration < maxIterations) {
      // Re-load config each iteration (fixes may have modified stack.yml or vault)
      const config = loadConfig(rootDir);

      // Strip stage booleans — only pass stages array so scan doesn't override it
      const { dev: _d, secrets: _sec, staging: _stg, prod: _p, stages: _s, ...cleanOptions } = options;
      const problems = await scan({
        ...cleanOptions,
        silent: true,
        stages: [stage],
      });

      const stageProblems = problems[stage] ?? [];
      // Filter out already-processed fixes
      const newProblems = stageProblems.filter(p => !processedIds.has(p.id));
      if (newProblems.length === 0) break;

      // Stage header on first iteration, re-scan marker on subsequent
      if (!stageHeaderShown) {
        const totalCount = newProblems.length;
        console.log('┌─ ' + stage.toUpperCase() + ' (' + totalCount + ' issue' + (totalCount > 1 ? 's' : '') + ')');
        stageHeaderShown = true;
      } else {
        console.log('│  ── re-scan (' + newProblems.length + ' new) ──');
      }

      let fixedAny = false;

      for (const problem of newProblems) {
        processedIds.add(problem.id);

        if (problem.fix) {
          const startTime = performance.now();
          try {
            const success = await problem.fix(config, rootDir);
            const duration = performance.now() - startTime;

            // Only show timing for slow fixes (> 1s)
            const timeSuffix = duration > 1000 ? ' (' + (duration / 1000).toFixed(1) + 's)' : '';

            if (success) {
              console.log('│  ✅ ' + problem.description + timeSuffix);
              result.fixed++;
              result.fixes.push({
                id: problem.id,
                stage,
                status: 'fixed',
                description: problem.description,
              });
              fixedAny = true;
            } else {
              console.log('│  ❌ ' + problem.description + timeSuffix);
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
            console.log('│  ❌ ' + problem.description + ': ' + errorMessage);
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
          // Manual fix — show short description only (details in summary)
          console.log('│  📝 ' + problem.description);
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

      if (!fixedAny) break; // No progress, stop iterating
      iteration++;
    }

    if (stageHeaderShown) {
      console.log('└─');
      console.log('');
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
  let targetStage: 'staging' | 'prod' | undefined;

  if (options.dev) stages = ['dev'];
  else if (options.secrets) stages = ['secrets'];
  else if (options.staging) {
    stages = ['dev', 'secrets', 'staging'];
    targetStage = 'staging'; // Only fix staging secrets
  }
  else if (options.prod) {
    stages = ['dev', 'secrets', 'prod'];
    targetStage = 'prod'; // Only fix prod secrets
  }
  else if (options.stages) stages = options.stages;

  // Dev-only gate: when dev_only is true (default), restrict to dev+secrets only
  // Secrets stage is always allowed (needed to set up tokens/keys before unlocking staging/prod)
  // CRITICAL: Keep targetStage so secrets fixes only run for the requested stage
  // Skip dev_only gate when running on the server (SSH'd in or CI)
  const onServer = process.env.FACTIII_ON_SERVER === 'true' || process.env.GITHUB_ACTIONS === 'true';
  if (isDevOnly(config) && !onServer) {
    if (stages.some(s => s !== 'dev' && s !== 'secrets')) {
      console.log('ℹ️  Dev-only mode (set dev_only: false in stack.local to unlock staging/prod)\n');
      stages = stages.filter(s => s === 'dev' || s === 'secrets');
    }
  }

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
    // dev and secrets always run locally — they never route via SSH
    if (stage === 'dev' || stage === 'secrets') {
      reachability[stage] = { reachable: true, via: 'local' };
      localStages.push(stage);
      continue;
    }

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
  const result = await runLocalFixes({ ...options, targetStage }, localStages);

  // Remote stages: delegate to the pipeline plugin that claims each stage
  for (const stage of remoteStages) {
    const claimingPlugin = findPipelineForStage(pipelinePlugins, stage, config);
    if (!claimingPlugin) continue;

    const PipelineClass = claimingPlugin as unknown as PipelinePluginClass;
    const pipeline = new PipelineClass(config);

    if (typeof pipeline.fixStage !== 'function') {
      // Pipeline doesn't have fixStage — run fixes locally instead
      const localResult = await runLocalFixes({ ...options, stages: [stage] }, [stage]);
      result.fixed += localResult.fixed;
      result.manual += localResult.manual;
      result.failed += localResult.failed;
      result.fixes.push(...localResult.fixes);
      continue;
    }

    const remoteResult = await pipeline.fixStage(stage, {}) as { handled: boolean; success?: boolean; error?: string };
    if (!remoteResult.handled) continue;

    // Remote fix already printed its own detailed summary inline.
    // Don't add a duplicate entry to the local summary — the user already saw
    // the server's output with individual fix results.
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log('');
  console.log('═'.repeat(60));
  console.log('  SUMMARY');
  console.log('═'.repeat(60));

  const allStages: Stage[] = ['dev', 'secrets', 'staging', 'prod'];
  let hasManualFixes = false;

  for (const stage of allStages) {
    const stageFixes = result.fixes.filter((f) => f.stage === stage);
    if (stageFixes.length === 0) continue;

    const fixed = stageFixes.filter(f => f.status === 'fixed').length;
    const manual = stageFixes.filter(f => f.status === 'manual').length;
    const failed = stageFixes.filter(f => f.status === 'failed').length;

    console.log('');
    console.log('  ' + stage.toUpperCase() + '  ✅ ' + fixed + '  📝 ' + manual + '  ❌ ' + failed);
    console.log('  ' + '─'.repeat(50));

    for (const fix of stageFixes) {
      if (fix.status === 'fixed') {
        console.log('  ✅ ' + (fix.description || fix.id));
      } else if (fix.status === 'manual') {
        hasManualFixes = true;
        console.log('  📝 ' + (fix.description || fix.id));
        if (fix.manualFix) {
          // Show first meaningful line of manual fix as hint
          const hint = fix.manualFix.trim().split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 0)[0];
          if (hint) {
            console.log('     → ' + hint);
          }
        }
      } else if (fix.status === 'failed') {
        console.log('  ❌ ' + (fix.description || fix.id));
        if (fix.error) {
          console.log('     → ' + fix.error);
        }
      }
    }
  }

  console.log('');
  console.log('═'.repeat(60));
  console.log(
    '  TOTAL: ' +
    '✅ ' + result.fixed + ' fixed' +
    '  📝 ' + result.manual + ' manual' +
    '  ❌ ' + result.failed + ' failed'
  );
  console.log('═'.repeat(60));

  // Show next-step guidance
  if (result.failed === 0 && result.manual === 0) {
    const hasProdStage = stages.includes('prod') || stages.includes('staging');
    if (hasProdStage) {
      console.log('');
      console.log('  ✅ All clear! Next: npx stack deploy --' + (stages.includes('prod') ? 'prod' : 'staging'));
    }
  } else if (hasManualFixes && result.failed === 0) {
    console.log('');
    console.log('  ⚠️  Fix the 📝 items above, then re-run: npx stack fix');
  } else if (result.failed > 0) {
    console.log('');
    console.log('  ❌ Fix the errors above, then re-run: npx stack fix');
  }

  // Exit with error if any fixes failed
  if (result.failed > 0) {
    process.exit(1);
  }

  return result;
}

export default fix;
