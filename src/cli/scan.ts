/**
 * Scan Command
 *
 * Runs scan side of all plugin fixes.
 * Returns problems found (which are the fixes that need to run).
 *
 * Usage:
 *   npx factiii scan           # Scan all stages
 *   npx factiii scan --dev     # Scan dev only
 *   npx factiii scan --staging # Scan staging only
 *   npx factiii scan --prod    # Scan prod only
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import yaml from 'js-yaml';

import { loadRelevantPlugins } from '../plugins/index.js';
import type { FactiiiConfig, Stage, Fix, Reachability, ScanOptions, ScanProblems } from '../types/index.js';

interface PluginClass {
  id: string;
  category: string;
  fixes?: Fix[];
  requiredEnvVars?: string[];
  canReach?: (stage: Stage, config: FactiiiConfig) => Reachability;
}

/**
 * Load relevant plugins based on config
 */
async function loadPlugins(rootDir: string): Promise<PluginClass[]> {
  const config = loadConfig(rootDir);

  // If no config exists, tell user to run init
  if (!config || Object.keys(config).length === 0) {
    console.error('\n❌ No factiii.yml found.');
    console.error('   Run: npx factiii init\n');
    process.exit(1);
  }

  return (await loadRelevantPlugins(rootDir, config)) as unknown as PluginClass[];
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
 * Generate env var fixes from plugin requiredEnvVars
 */
function generateEnvVarFixes(
  plugin: PluginClass,
  rootDir: string,
  _config: FactiiiConfig
): Fix[] {
  const fixes: Fix[] = [];

  for (const varName of plugin.requiredEnvVars ?? []) {
    // Check .env.example has the var
    fixes.push({
      id: `missing-env-example-${varName.toLowerCase()}`,
      stage: 'dev',
      severity: 'critical',
      description: `${varName} not found in .env.example`,
      plugin: plugin.id,
      scan: async (): Promise<boolean> => {
        const envPath = path.join(rootDir, '.env.example');
        if (!fs.existsSync(envPath)) return true;
        const content = fs.readFileSync(envPath, 'utf8');
        return !content.includes(`${varName}=`);
      },
      fix: null,
      manualFix: `Add ${varName}=your_value to .env.example`,
    });

    // Check .env.staging has the var (only if staging environment is defined)
    fixes.push({
      id: `missing-env-staging-${varName.toLowerCase()}`,
      stage: 'staging',
      severity: 'critical',
      description: `${varName} not found in .env.staging`,
      plugin: plugin.id,
      scan: async (config: FactiiiConfig): Promise<boolean> => {
        // Only check if staging environment is defined in config
        const hasStagingEnv = config?.environments?.staging;
        if (!hasStagingEnv) return false; // Skip check if staging not configured

        const envPath = path.join(rootDir, '.env.staging');
        if (!fs.existsSync(envPath)) return true;
        const content = fs.readFileSync(envPath, 'utf8');
        return !content.includes(`${varName}=`);
      },
      fix: null,
      manualFix: `Add ${varName}=staging_value to .env.staging`,
    });

    // Check .env.prod has the var (only if prod environment is defined)
    fixes.push({
      id: `missing-env-prod-${varName.toLowerCase()}`,
      stage: 'prod',
      severity: 'critical',
      description: `${varName} not found in .env.prod`,
      plugin: plugin.id,
      scan: async (config: FactiiiConfig): Promise<boolean> => {
        // Only check if prod environment is defined in config
        const hasProdEnv = config?.environments?.prod || config?.environments?.production;
        if (!hasProdEnv) return false; // Skip check if prod not configured

        const envPath = path.join(rootDir, '.env.prod');
        if (!fs.existsSync(envPath)) return true;
        const content = fs.readFileSync(envPath, 'utf8');
        return !content.includes(`${varName}=`);
      },
      fix: null,
      manualFix: `Add ${varName}=production_value to .env.prod`,
    });
  }

  return fixes;
}

/**
 * Get status icon and label for a stage based on reachability and problems
 */
function getStageStatus(
  stage: Stage,
  reach: Reachability | undefined,
  problemCount: number
): { icon: string; label: string; detail: string } {
  // Stage is not reachable
  if (reach && !reach.reachable) {
    return {
      icon: '❌',
      label: 'Cannot reach',
      detail: reach.reason,
    };
  }

  // Stage is reachable via workflow (checked when workflow runs)
  if (reach && reach.reachable && reach.via === 'workflow') {
    return {
      icon: '🔄',
      label: 'Via workflow',
      detail: 'Checked when workflow runs',
    };
  }

  // Stage is directly reachable
  const via = reach?.reachable && reach.via ? reach.via : 'local';

  if (problemCount === 0) {
    return {
      icon: '✅',
      label: 'Ready',
      detail: via,
    };
  } else {
    return {
      icon: '❌',
      label: `${problemCount} issue${problemCount > 1 ? 's' : ''}`,
      detail: via,
    };
  }
}

/**
 * Display problems grouped by stage with clear pipeline status
 */
function displayProblems(
  problems: ScanProblems,
  reachability: Record<string, Reachability>,
  options: ScanOptions = {}
): void {
  if (options.silent) return;

  const stages: Stage[] = ['dev', 'secrets', 'staging', 'prod'];
  let totalProblems = 0;
  const unreachableStages: { stage: Stage; reason: string }[] = [];

  // Count total problems
  for (const stage of stages) {
    if (reachability[stage]) {
      const stageProblems = problems[stage] ?? [];
      // Only count problems for stages that were actually scanned (not via workflow)
      const reach = reachability[stage];
      if (reach?.reachable && reach.via !== 'workflow') {
        totalProblems += stageProblems.length;
      }
    }
  }

  // Header
  console.log('\n' + '═'.repeat(60));
  console.log('PIPELINE STATUS');
  console.log('═'.repeat(60) + '\n');

  // Stage status overview
  for (const stage of stages) {
    const reach = reachability[stage];
    if (!reach) continue; // Stage wasn't checked

    const problemCount = problems[stage]?.length ?? 0;
    const status = getStageStatus(stage, reach, problemCount);

    // Format: [STAGE]     icon Status (detail)
    const stageLabel = `[${stage.toUpperCase()}]`.padEnd(10);
    const statusLine = `${stageLabel} ${status.icon} ${status.label}`;

    if (status.detail && status.label !== 'Cannot reach') {
      console.log(`${statusLine} (${status.detail})`);
    } else {
      console.log(statusLine);
    }

    // Track unreachable stages for blockers section
    if (!reach.reachable) {
      unreachableStages.push({ stage, reason: reach.reason });
    }
  }

  // Blockers section (only if there are unreachable stages)
  if (unreachableStages.length > 0) {
    console.log('\n' + '─'.repeat(60));
    console.log('BLOCKERS');
    console.log('─'.repeat(60) + '\n');

    for (const { stage, reason } of unreachableStages) {
      // Determine which stage this blocks access FROM
      const fromStage = stage === 'secrets' ? 'dev' : stage === 'staging' || stage === 'prod' ? 'secrets' : 'dev';
      console.log(`❌ ${fromStage.toUpperCase()} → ${stage.toUpperCase()}: ${reason}`);

      // Provide hint for common blockers
      if (reason.includes('GITHUB_TOKEN')) {
        console.log('   💡 Run: export GITHUB_TOKEN=your_token');
      }
    }
  }

  // Issues section (only if there are problems)
  if (totalProblems > 0) {
    console.log('\n' + '─'.repeat(60));
    console.log('ISSUES BY STAGE');
    console.log('─'.repeat(60) + '\n');

    for (const stage of stages) {
      const reach = reachability[stage];
      if (!reach) continue;

      const stageProblems = problems[stage] ?? [];

      // Skip stages reached via workflow or not reachable
      if (!reach.reachable || reach.via === 'workflow') {
        continue;
      }

      if (stageProblems.length > 0) {
        console.log(`${stage.toUpperCase()}:`);
        for (const problem of stageProblems) {
          const icon = problem.fix ? '🔧' : '📝';
          const autoFix = problem.fix ? '(auto-fixable)' : '(manual)';
          console.log(`   ${icon} ${problem.description} ${autoFix}`);
        }
        console.log('');
      }
    }
  }

  // Summary
  console.log('─'.repeat(60));
  if (totalProblems === 0 && unreachableStages.length === 0) {
    console.log('✅ All checks passed!\n');
  } else if (totalProblems === 0 && unreachableStages.length > 0) {
    console.log('⚠️  Some stages cannot be reached. Fix blockers above.\n');
  } else {
    console.log(`Found ${totalProblems} issue${totalProblems > 1 ? 's' : ''}.`);
    console.log('💡 Run: npx factiii fix\n');
  }
}

/**
 * Get pipeline plugin from loaded plugins
 */
function getPipelinePlugin(plugins: PluginClass[]): PluginClass | undefined {
  return plugins.find((p) => p.category === 'pipeline');
}

/**
 * Main scan function
 */
export async function scan(options: ScanOptions = {}): Promise<ScanProblems> {
  const rootDir = options.rootDir ?? process.cwd();
  const config = loadConfig(rootDir);

  // If commit hash provided, verify we're scanning the right code
  if (options.commit) {
    try {
      const currentCommit = execSync('git rev-parse HEAD', {
        cwd: rootDir,
        encoding: 'utf8',
      }).trim();

      if (!options.silent) {
        console.log(`📍 Scanning commit: ${options.commit.substring(0, 7)}`);
      }

      if (currentCommit !== options.commit) {
        console.warn(
          `⚠️  Warning: Expected commit ${options.commit.substring(0, 7)} but found ${currentCommit.substring(0, 7)}`
        );
      }
    } catch {
      // Not a git repo or git not available, skip verification
    }
  }

  // Determine which stages to scan
  let stages: Stage[] = ['dev', 'secrets', 'staging', 'prod'];
  if (options.dev) stages = ['dev'];
  else if (options.secrets) stages = ['secrets'];
  else if (options.staging) stages = ['staging'];
  else if (options.prod) stages = ['prod'];
  else if (options.stages) stages = options.stages;

  // Load all plugins
  const plugins = await loadPlugins(rootDir);

  // Get pipeline plugin to check reachability
  const pipelinePlugin = getPipelinePlugin(plugins);

  // Check reachability for each stage
  const reachability: Record<string, Reachability> = {};
  const reachableStages: Stage[] = [];

  for (const stage of stages) {
    if (pipelinePlugin && typeof pipelinePlugin.canReach === 'function') {
      reachability[stage] = pipelinePlugin.canReach(stage, config);

      // Only scan stages that are reachable directly (not via workflow)
      if (
        reachability[stage]?.reachable &&
        'via' in reachability[stage]! &&
        reachability[stage]!.via !== 'workflow'
      ) {
        reachableStages.push(stage);
      }
    } else {
      // No pipeline plugin or no canReach method - assume all reachable
      reachability[stage] = { reachable: true, via: 'local' };
      reachableStages.push(stage);
    }
  }

  // Collect all fixes from all plugins
  const allFixes: Fix[] = [];
  for (const plugin of plugins) {
    // Add plugin fixes
    for (const fix of plugin.fixes ?? []) {
      allFixes.push({ ...fix, plugin: plugin.id });
    }

    // Add auto-generated env var fixes
    const envFixes = generateEnvVarFixes(plugin, rootDir, config);
    allFixes.push(...envFixes);
  }

  // Run scan() for each fix, collect problems found
  const problems: ScanProblems = {
    dev: [],
    secrets: [],
    staging: [],
    prod: [],
  };

  if (!options.silent) {
    console.log('🔍 Scanning...\n');
  }

  for (const fix of allFixes) {
    // Skip if stage not in reachable stages
    if (!reachableStages.includes(fix.stage)) continue;

    try {
      // Run the scan function
      const hasProblem = await fix.scan(config, rootDir);

      if (hasProblem) {
        problems[fix.stage].push(fix);
      }
    } catch (e) {
      // Scan failed - treat as problem
      if (!options.silent) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.log(`   ⚠️  Error scanning ${fix.id}: ${errorMessage}`);
      }
    }
  }

  // Display problems grouped by stage
  displayProblems(problems, reachability, options);

  // Return the fixes needed (problems found)
  return problems;
}

export default scan;

