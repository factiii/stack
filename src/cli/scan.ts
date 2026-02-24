/**
 * Scan Command
 *
 * Runs scan side of all plugin fixes.
 * Returns problems found (which are the fixes that need to run).
 *
 * Usage:
 *   npx stack scan           # Scan all stages
 *   npx stack scan --dev     # Scan dev only
 *   npx stack scan --staging # Scan staging only
 *   npx stack scan --prod    # Scan prod only
 *
 * ============================================================
 * STAGE EXECUTION PATTERN - DO NOT MODIFY WITHOUT READING
 * ============================================================
 *
 * How this works:
 *
 * 1. User specifies stage: --dev, --secrets, --staging, --prod
 *    Or no flag = all stages in order
 *
 * 2. This file groups all plugin fixes by their stage property
 *
 * 3. For each requested stage, asks PIPELINE PLUGIN: canReach(stage)?
 *    - { reachable: true, via: 'local' } → run fixes locally
 *    - { reachable: true, via: 'workflow' } → pipeline triggers workflow
 *    - { reachable: false, reason: '...' } → show error, stop
 *
 * CRITICAL: This file does NOT know about:
 *   - GITHUB_TOKEN (that's pipeline plugin's concern)
 *   - SSH keys (that's pipeline plugin's concern)
 *   - How to trigger workflows (that's pipeline plugin's concern)
 *
 * This file ONLY:
 *   - Collects fixes from all plugins
 *   - Groups them by stage
 *   - Asks pipeline if each stage is reachable
 *   - Runs fixes for reachable stages
 *
 * This keeps scan.ts compatible with ANY pipeline plugin.
 *
 * ============================================================
 * FOR PIPELINE PLUGIN AUTHORS:
 * ============================================================
 *
 * When your workflow/CI SSHs to a server, you MUST call the
 * command with the specific stage flag:
 *
 *   npx stack fix --staging    # NOT just "npx stack fix"
 *   npx stack scan --prod      # NOT just "npx stack scan"
 *
 * Without the stage flag, the command will try to run ALL stages
 * and may try to trigger workflows for stages it can't reach.
 *
 * Your canReach() should return 'local' when running on the
 * target server (e.g., check GITHUB_ACTIONS or CI env vars).
 *
 * ============================================================
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import yaml from 'js-yaml';

import { getStackConfigPath } from '../constants/config-files.js';
import { loadRelevantPlugins, registry } from '../plugins/index.js';
import type { FactiiiConfig, Stage, Fix, Reachability, ScanOptions, ScanProblems, ServerOS } from '../types/index.js';
import { extractEnvironments, loadLocalConfig } from '../utils/config-helpers.js';

interface PluginClass {
  id: string;
  category: string;
  fixes?: Fix[];
  requiredEnvVars?: string[];
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
  scanStage(stage: Stage, options: Record<string, unknown>): Promise<{ handled: boolean }>;
}

/**
 * Load relevant plugins based on config.
 * Returns null if no config exists (bootstrap needed).
 */
async function loadPlugins(rootDir: string): Promise<PluginClass[] | null> {
  const config = loadConfig(rootDir);

  // If no config exists, return null to signal bootstrap mode
  if (!config || Object.keys(config).length === 0) {
    const configPath = getStackConfigPath(rootDir);
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      if (!content || content.trim().length === 0) {
        return null; // Empty config — needs bootstrap
      } else {
        console.error('\n[ERROR] Config contains no valid configuration.');
        console.error('   Check your YAML syntax or run: npx stack init --force\n');
        process.exit(1);
      }
    }
    return null; // No config file — needs bootstrap
  }

  return (await loadRelevantPlugins(rootDir, config)) as unknown as PluginClass[];
}

/**
 * Load only bootstrap plugins (factiii pipeline) when no config exists.
 * The factiii pipeline always loads (shouldLoad = true) and its bootstrap
 * fixes will create the config files.
 */
function loadBootstrapPlugins(): PluginClass[] {
  const plugins: PluginClass[] = [];
  const factiii = registry.pipelines['factiii'];
  if (factiii) {
    plugins.push(factiii as unknown as PluginClass);
  }
  return plugins;
}

/**
 * Run bootstrap fixes to create config files.
 * Only runs dev-stage bootstrap fixes (missing-stack-yml, missing-stack-auto-yml, etc.)
 * in auto-fix mode so the re-run can proceed normally.
 */
async function runBootstrapFixes(plugins: PluginClass[], rootDir: string): Promise<void> {
  const config = {} as FactiiiConfig;
  const bootstrapFixIds = [
    'missing-stack-yml',
    'missing-stack-auto-yml',
    'missing-stack-local-yml',
    'gitignore-local-config',
    'gitignore-env-staging',
    'gitignore-env-prod',
  ];

  for (const plugin of plugins) {
    for (const fix of plugin.fixes ?? []) {
      if (fix.stage !== 'dev') continue;
      if (!bootstrapFixIds.includes(fix.id)) continue;

      try {
        const hasProblem = await fix.scan(config, rootDir);
        if (hasProblem && fix.fix) {
          await fix.fix(config, rootDir);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log('  [!] Bootstrap error (' + fix.id + '): ' + msg);
      }
    }
  }
}

/**
 * Load config from stack.yml (or legacy stack.yml)
 */
function loadConfig(rootDir: string): FactiiiConfig {
  const configPath = getStackConfigPath(rootDir);

  if (!fs.existsSync(configPath)) {
    return {} as FactiiiConfig;
  }

  try {
    return (yaml.load(fs.readFileSync(configPath, 'utf8')) as FactiiiConfig) ?? ({} as FactiiiConfig);
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.error('[!] Error parsing config: ' + errorMessage);
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
      id: 'missing-env-example-' + varName.toLowerCase(),
      stage: 'dev',
      severity: 'critical',
      description: varName + ' not found in .env.example',
      plugin: plugin.id,
      scan: async (): Promise<boolean> => {
        const envPath = path.join(rootDir, '.env.example');
        if (!fs.existsSync(envPath)) return true;
        const content = fs.readFileSync(envPath, 'utf8');
        return !content.includes(varName + '=');
      },
      fix: null,
      manualFix: 'Add ' + varName + '=your_value to .env.example (format: KEY=value, one per line)',
    });

    // Check .env.staging has the var (only if staging environment is defined)
    fixes.push({
      id: 'missing-env-staging-' + varName.toLowerCase(),
      stage: 'staging',
      severity: 'critical',
      description: varName + ' not found in .env.staging',
      plugin: plugin.id,
      scan: async (config: FactiiiConfig): Promise<boolean> => {
        // Only check if staging environment is defined in config
        const hasStagingEnv = config?.environments?.staging;
        if (!hasStagingEnv) return false; // Skip check if staging not configured

        const envPath = path.join(rootDir, '.env.staging');
        if (!fs.existsSync(envPath)) return true;
        const content = fs.readFileSync(envPath, 'utf8');
        return !content.includes(varName + '=');
      },
      fix: null,
      manualFix: 'Add ' + varName + '=staging_value to .env.staging (use your staging environment value)',
    });

    // Check .env.prod has the var (only if prod environment is defined)
    fixes.push({
      id: 'missing-env-prod-' + varName.toLowerCase(),
      stage: 'prod',
      severity: 'critical',
      description: varName + ' not found in .env.prod',
      plugin: plugin.id,
      scan: async (config: FactiiiConfig): Promise<boolean> => {
        // Only check if prod environment is defined in config
        const hasProdEnv = config?.environments?.prod || config?.environments?.production;
        if (!hasProdEnv) return false; // Skip check if prod not configured

        const envPath = path.join(rootDir, '.env.prod');
        if (!fs.existsSync(envPath)) return true;
        const content = fs.readFileSync(envPath, 'utf8');
        return !content.includes(varName + '=');
      },
      fix: null,
      manualFix: 'Add ' + varName + '=production_value to .env.prod (use your production environment value)',
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
      icon: '[X]',
      label: 'Cannot reach',
      detail: reach.reason,
    };
  }

  // Stage is reachable remotely (pipeline handles it)
  if (reach && reach.reachable && reach.via !== 'local') {
    return {
      icon: '[~]',
      label: 'Via ' + reach.via,
      detail: 'Handled by pipeline plugin',
    };
  }

  // Stage is directly reachable (local)
  if (problemCount === 0) {
    return {
      icon: '[OK]',
      label: 'Ready',
      detail: 'local',
    };
  } else {
    return {
      icon: '[X]',
      label: problemCount + ' issue' + (problemCount > 1 ? 's' : ''),
      detail: 'local',
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

  // Count total problems (only for locally-scanned stages)
  for (const stage of stages) {
    if (reachability[stage]) {
      const stageProblems = problems[stage] ?? [];
      const reach = reachability[stage];
      if (reach?.reachable && reach.via === 'local') {
        totalProblems += stageProblems.length;
      }
    }
  }

  // Header
  console.log('\nPIPELINE STATUS\n');

  // Stage status overview
  for (const stage of stages) {
    const reach = reachability[stage];
    if (!reach) continue; // Stage wasn't checked

    const problemCount = problems[stage]?.length ?? 0;
    const status = getStageStatus(stage, reach, problemCount);

    // Format: [STAGE]     icon Status (detail)
    const stageLabel = ('[' + stage.toUpperCase() + ']').padEnd(10);
    const statusLine = stageLabel + ' ' + status.icon + ' ' + status.label;

    if (status.detail && status.label !== 'Cannot reach') {
      console.log(statusLine + ' (' + status.detail + ')');
    } else {
      console.log(statusLine);
    }

    // Show reason inline for unreachable stages
    if (!reach.reachable) {
      console.log('           Reason: ' + reach.reason);
      unreachableStages.push({ stage, reason: reach.reason });
    }
  }

  // Blockers section (only if there are unreachable stages)
  if (unreachableStages.length > 0) {
    console.log('\n' + '-'.repeat(60));
    console.log('BLOCKERS');
    console.log('-'.repeat(60) + '\n');

    for (const { stage, reason } of unreachableStages) {
      console.log('[!] ' + stage.toUpperCase() + ' unreachable');
      console.log('    Reason: ' + reason);

      // Provide smart hints based on the actual reason
      const reasonLower = reason.toLowerCase();
      if (reasonLower.includes('vault_path') || reasonLower.includes('ansible')) {
        console.log('    Fix: Add ansible config to stack.yml:');
        console.log('           ansible:');
        console.log('             vault_path: group_vars/all/vault.yml');
        console.log('             vault_password_file: ~/.vault_pass');
        console.log('         Or run: npx stack init');
      } else if (reasonLower.includes('vault password') || reasonLower.includes('vault_pass')) {
        console.log('    Fix: Create vault password file:');
        console.log('           echo "your-password" > ~/.vault_pass');
        console.log('         Or run: npx stack init');
      } else if (reasonLower.includes('ssh') || reasonLower.includes('deploy_key')) {
        console.log('    Fix: Set up SSH key for ' + stage + ':');
        console.log('           npx stack init              (guided setup)');
        console.log('           npx stack secrets set ' + stage.toUpperCase() + '_SSH   (add key to vault)');
        console.log('           npx stack secrets write-ssh-keys  (extract keys to ~/.ssh/)');
      } else if (reasonLower.includes('github_token')) {
        console.log('    Fix: export GITHUB_TOKEN=your_token');
        console.log('         Or set up SSH keys instead (preferred):');
        console.log('           npx stack init');
      } else {
        console.log('    Fix: npx stack init');
      }
      console.log('');
    }
  }

  // Issues section (only if there are problems)
  if (totalProblems > 0) {
    console.log('\n' + '-'.repeat(60));
    console.log('ISSUES BY STAGE');
    console.log('-'.repeat(60) + '\n');

    for (const stage of stages) {
      const reach = reachability[stage];
      if (!reach) continue;

      const stageProblems = problems[stage] ?? [];

      // Skip stages not scanned locally
      if (!reach.reachable || reach.via !== 'local') {
        continue;
      }

      if (stageProblems.length > 0) {
        console.log(stage.toUpperCase() + ':');
        for (const problem of stageProblems) {
          const icon = problem.fix ? '[fix]' : '[man]';
          const autoFix = problem.fix ? '(auto-fixable)' : '(manual)';
          console.log('  ' + icon + ' ' + problem.description + ' ' + autoFix);
        }
        console.log('');
      }
    }
  }

  // Summary
  console.log('-'.repeat(60));
  if (totalProblems === 0 && unreachableStages.length === 0) {
    console.log('[OK] All checks passed!\n');
  } else if (totalProblems === 0 && unreachableStages.length > 0) {
    console.log('[!] Some stages cannot be reached. Fix blockers above.\n');
  } else {
    console.log('Found ' + totalProblems + ' issue' + (totalProblems > 1 ? 's' : '') + '.');
    console.log('Hint: Run: npx stack fix\n');
  }
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
  let lastReason = 'No pipeline plugin loaded';
  for (const plugin of pipelinePlugins) {
    if (typeof plugin.canReach === 'function') {
      const result = plugin.canReach(stage, config);
      if (result.reachable) return result;
      lastReason = result.reason ?? 'Unreachable';
    }
  }
  return { reachable: false, reason: lastReason };
}

/**
 * Main scan function
 */
export async function scan(options: ScanOptions = {}, _isRerun = false): Promise<ScanProblems> {
  const rootDir = options.rootDir ?? process.cwd();

  // Bootstrap: if no config exists, create config files via bootstrap fixes
  if (!_isRerun) {
    const pluginsOrNull = await loadPlugins(rootDir);
    if (pluginsOrNull === null) {
      console.log('No stack.yml found. Setting up project...\n');
      const bootstrapPlugins = loadBootstrapPlugins();
      if (bootstrapPlugins.length === 0) {
        console.error('\n[ERROR] No pipeline plugin available for bootstrap.');
        console.error('   This should not happen. Reinstall @factiii/stack.\n');
        process.exit(1);
      }
      await runBootstrapFixes(bootstrapPlugins, rootDir);
      console.log('');
      // Re-run scan now that config files exist
      return scan(options, true);
    }
  }

  const config = loadConfig(rootDir);

  // After bootstrap, if config still doesn't exist, give up
  if (_isRerun && (!config || Object.keys(config).length === 0)) {
    console.error('\n[ERROR] Bootstrap failed to create stack.yml.');
    console.error('   Run: npx stack init\n');
    process.exit(1);
  }

  // If commit hash provided, verify we're scanning the right code
  if (options.commit) {
    try {
      const currentCommit = execSync('git rev-parse HEAD', {
        cwd: rootDir,
        encoding: 'utf8',
      }).trim();

      if (!options.silent) {
        console.log('Scanning commit: ' + options.commit.substring(0, 7));
      }

      if (currentCommit !== options.commit) {
        console.warn(
          '[!] Warning: Expected commit ' + options.commit.substring(0, 7) + ' but found ' + currentCommit.substring(0, 7)
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

  // Load all plugins (guaranteed non-null after bootstrap check above)
  const plugins = (await loadPlugins(rootDir))!;

  // Get all pipeline plugins to check reachability (multi-pipeline support)
  const pipelinePlugins = getAllPipelinePlugins(plugins);
  const pipelinePlugin = getPipelinePlugin(plugins);

  // Check reachability for each stage
  // Separate local vs remote stages — pipeline plugin handles remote
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
    console.log('Scanning...\n');
  }

  // Get target server OS for each stage (for OS filtering)
  const environments = extractEnvironments(config);
  const stageToOS: Record<string, ServerOS | undefined> = {};
  for (const [name, env] of Object.entries(environments)) {
    // Map environment names to stages
    if (name.startsWith('staging') || name.startsWith('stage-')) {
      stageToOS['staging'] = env.server as ServerOS | undefined;
    } else if (name.startsWith('prod') || name === 'production') {
      stageToOS['prod'] = env.server as ServerOS | undefined;
    }
  }

  // Read dev OS from stack.local.yml for OS-specific dev-stage fix filtering
  const localConfig = loadLocalConfig(rootDir);
  if (localConfig.dev_os) {
    stageToOS['dev'] = localConfig.dev_os as ServerOS;
  }

  for (const fix of allFixes) {
    // Skip if stage not in local stages
    if (!localStages.includes(fix.stage)) continue;

    // OS filtering: Skip fixes that don't match the target OS
    if (fix.os) {
      const targetOS = stageToOS[fix.stage];
      if (targetOS) {
        const fixOSList = Array.isArray(fix.os) ? fix.os : [fix.os];
        if (!fixOSList.includes(targetOS)) {
          continue; // Skip this fix - OS doesn't match
        }
      }
    }

    const startTime = performance.now();
    try {
      // Run the scan function
      const hasProblem = await fix.scan(config, rootDir);
      const duration = performance.now() - startTime;

      // Log timing for slow checks (> 500ms)
      if (duration > 500 && !options.silent) {
        console.log('   [' + duration.toFixed(0) + 'ms] ' + fix.id);
      }

      if (hasProblem) {
        problems[fix.stage].push(fix);
      }
    } catch (e) {
      // Scan failed - treat as problem
      if (!options.silent) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.log('  [!] Error scanning ' + fix.id + ': ' + errorMessage);
      }
    }
  }

  // Remote stages: delegate to pipeline plugin
  if (remoteStages.length > 0 && !options.silent) {
    const PipelineClass = pipelinePlugin as unknown as PipelinePluginClass;
    if (PipelineClass) {
      const pipeline = new PipelineClass(config);
      for (const stage of remoteStages) {
        await pipeline.scanStage(stage, {});
      }
    }
  }

  // Display problems grouped by stage
  displayProblems(problems, reachability, options);

  // Return the fixes needed (problems found)
  return problems;
}

export default scan;
