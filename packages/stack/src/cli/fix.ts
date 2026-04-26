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
import { loadRelevantPlugins } from '../plugins/index.js';
import { loadConfig, isDevOnly } from '../utils/config-helpers.js';
import { generateEnvVarFixes } from './scan.js';
import type { FactiiiConfig, Fix, FixOptions, FixResult, Stage, Reachability } from '../types/index.js';

interface PluginClass {
  id: string;
  category: string;
  canReach?: (stage: Stage, config: FactiiiConfig) => Reachability;
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

async function runChainAsFix(
  options: FixOptions,
  reachableStages: Stage[],
): Promise<FixResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const config = loadConfig(rootDir);

  // Build the fix list the same way scan.ts does (deduplicate + env-var fixes
  // + os/targetStage filter). Extract into a shared helper if the duplication grows.
  const plugins = await loadRelevantPlugins(rootDir, config);
  const allFixes: Fix[] = [];
  const seen = new Set<string>();
  for (const plugin of plugins) {
    for (const fix of (plugin as { fixes?: Fix[] }).fixes ?? []) {
      const key = fix.id + ':' + fix.stage;
      if (seen.has(key)) continue;
      seen.add(key);
      allFixes.push({ ...fix, plugin: (plugin as { id: string }).id });
    }
    // Add auto-generated env var fixes from plugin requiredEnvVars
    const envFixes = generateEnvVarFixes(plugin as { id: string; category: string; requiredEnvVars?: string[] }, rootDir, config);
    allFixes.push(...envFixes);
  }

  const filtered = allFixes.filter((fix) => {
    if (options.targetStage && fix.targetStage && fix.targetStage !== options.targetStage) return false;
    return true;
  });

  const { runStageChain } = await import('../utils/stage-chain.js');
  const chain = await runStageChain(filtered, {
    config,
    rootDir,
    stages: reachableStages,
    applyFixes: true,
    onOutcome: (outcome, fix, _stage) => {
      // Streaming progress: print each outcome as it lands.
      if (outcome.status === 'fixed') {
        console.log('  ✅ ' + fix.description);
      } else if (outcome.status === 'failed') {
        console.log('  ❌ ' + fix.description + (outcome.reason ? ' — ' + outcome.reason : ''));
      } else if (outcome.status === 'manual') {
        console.log('  📝 ' + fix.description);
      } else if (outcome.status === 'skipped') {
        console.log('  ⊘ ' + fix.description + ' — ' + (outcome.reason ?? 'skipped'));
      }
    },
  });

  // Translate StageChainResult → FixResult (legacy shape).
  const result: FixResult = { fixed: 0, manual: 0, failed: 0, fixes: [] };
  for (const stage of reachableStages) {
    const dag = chain.byStage.get(stage);
    if (!dag) continue;
    for (const [id, outcome] of dag.outcomes) {
      const fix = filtered.find((f) => f.id === id);
      if (!fix) continue;
      if (outcome.status === 'fixed') {
        result.fixed++;
        result.fixes.push({ id, stage, status: 'fixed', description: fix.description });
      } else if (outcome.status === 'manual') {
        result.manual++;
        result.fixes.push({
          id, stage, status: 'manual', description: fix.description, manualFix: fix.manualFix,
        });
      } else if (outcome.status === 'failed') {
        result.failed++;
        result.fixes.push({
          id, stage, status: 'failed', description: fix.description, error: outcome.reason,
        });
      }
      // 'ok' and 'skipped' are not surfaced in the legacy summary — same as before.
    }
  }
  return result;
}

export async function fix(options: FixOptions = {}): Promise<FixResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const config = loadConfig(rootDir);

  console.log('Running auto-fixes...\n');

  // Determine which stages to fix
  let stages: Stage[] = ['dev', 'staging', 'prod'];
  let targetStage: 'staging' | 'prod' | undefined;

  if (options.dev) stages = ['dev'];
  else if (options.staging) {
    stages = ['dev', 'staging'];
    targetStage = 'staging'; // Only fix staging secrets
  }
  else if (options.prod) {
    stages = ['dev', 'prod'];
    targetStage = 'prod'; // Only fix prod secrets
  }
  else if (options.stages) stages = options.stages;

  // Dev-only gate: when dev_only is true (default), restrict to dev only
  // CRITICAL: Keep targetStage so secrets fixes only run for the requested stage
  // Skip dev_only gate when running on the server (SSH'd in or CI)
  const onServer = process.env.FACTIII_ON_SERVER === 'true' || process.env.GITHUB_ACTIONS === 'true';
  if (isDevOnly(config) && !onServer) {
    if (stages.some(s => s !== 'dev')) {
      // User explicitly passed --staging or --prod — auto-unlock
      const localPath = path.join(rootDir, 'stack.local.yml');
      if (fs.existsSync(localPath)) {
        let localContent = fs.readFileSync(localPath, 'utf8');
        if (localContent.includes('dev_only: true')) {
          localContent = localContent.replace('dev_only: true', 'dev_only: false');
          fs.writeFileSync(localPath, localContent);
          console.log('ℹ️  Unlocked staging/prod in stack.local.yml\n');
        }
      }
    }
  }

  // Load all plugins to check reachability
  const plugins = await loadRelevantPlugins(rootDir, config);
  const pipelinePlugins = getAllPipelinePlugins(plugins as unknown as PluginClass[]);

  // Check reachability for each stage.
  // Dev-direct: every reachable stage runs locally on the dev machine.
  const reachability: Record<string, Reachability> = {};

  for (const stage of stages) {
    // dev always runs locally — it never routes via SSH
    if (stage === 'dev') {
      reachability[stage] = { reachable: true, via: 'local' };
      continue;
    }

    if (pipelinePlugins.length > 0) {
      // Check all pipeline plugins — first reachable wins
      reachability[stage] = checkReachability(pipelinePlugins, stage, config);
    } else {
      // No pipeline plugin or no canReach method - assume all reachable locally
      reachability[stage] = { reachable: true, via: 'local' };
    }
  }

  const reachableStages = stages.filter((s) => reachability[s]?.reachable);

  // Run fixes for all reachable stages via runStageChain (dev-direct: no remote delegation)
  const result = await runChainAsFix({ ...options, targetStage }, reachableStages);

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log('');
  console.log('═'.repeat(60));
  console.log('  SUMMARY');
  console.log('═'.repeat(60));

  const allStages: Stage[] = ['dev', 'staging', 'prod'];
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

  // Clear ~/.aws/credentials after AWS operations (security: never leave creds on disk)
  try {
    const { clearAwsCredentials, isAwsConfigured } = await import('../plugins/pipelines/aws/utils/aws-helpers.js');
    if (isAwsConfigured(config)) {
      clearAwsCredentials();
    }
  } catch {
    // AWS module may not be available — skip cleanup
  }

  // Exit with error if any fixes failed
  if (result.failed > 0) {
    process.exit(1);
  }

  return result;
}

export default fix;
