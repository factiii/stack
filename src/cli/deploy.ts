/**
 * Deploy Command
 *
 * Deploys to specified environment by delegating to the pipeline plugin.
 * The pipeline plugin decides how to reach the stage (local vs workflow trigger).
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
import type { FactiiiConfig, DeployOptions, DeployResult, Stage } from '../types/index.js';
import { extractEnvironments, getStageFromEnvironment } from '../utils/config-helpers.js';

/**
 * Pipeline plugin class interface
 */
interface PipelinePluginClass {
  id: string;
  category: 'pipeline';
  new (config: FactiiiConfig): PipelinePluginInstance;
}

/**
 * Pipeline plugin instance interface
 */
interface PipelinePluginInstance {
  deployStage(stage: Stage, options: DeployOptions): Promise<DeployResult>;
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
 * Deploy to a specified environment
 *
 * This command delegates to the pipeline plugin, which decides how to reach
 * the target stage based on canReach():
 * - 'local': Execute deployment directly
 * - 'workflow': Trigger a workflow (e.g., GitHub Actions)
 * - Not reachable: Return error with reason
 */
export async function deploy(environment: string, options: DeployOptions = {}): Promise<DeployResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const config = loadConfig(rootDir);

  console.log('════════════════════════════════════════════════════════════');
  console.log('🚀 FACTIII DEPLOY');
  console.log('════════════════════════════════════════════════════════════\n');

  // ============================================================
  // CRITICAL: Environment Validation
  // ============================================================
  // Why this exists: Supports multiple environments per stage
  // What breaks if changed: Invalid environments could be deployed
  // Dependencies: extractEnvironments, getStageFromEnvironment
  // ============================================================

  // Validate environment exists in config
  const environments = extractEnvironments(config);

  if (!environments[environment]) {
    const available = Object.keys(environments).join(', ');
    console.log(`❌ Environment '${environment}' not found in config.`);
    console.log(`   Available environments: ${available || 'none'}`);
    return {
      success: false,
      error: `Environment '${environment}' not found. Available: ${available}`,
    };
  }

  // Map environment name to stage (staging2 -> staging, prod2 -> prod, etc.)
  let stage: Stage;
  try {
    stage = getStageFromEnvironment(environment);
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.log(`❌ ${errorMessage}`);
    return { success: false, error: errorMessage };
  }

  console.log(`📋 Environment: ${environment} (${stage} stage)\n`);

  console.log('📋 Stage 1: Running pre-deploy checks...\n');

  // First run scan to check for blocking issues
  const problems = await scan({ ...options, silent: true });

  // Only block on CRITICAL issues - warnings/info will be auto-fixed during deployment
  const criticalProblems = Object.values(problems)
    .flat()
    .filter(fix => fix && fix.severity === 'critical');

  if (criticalProblems.length > 0) {
    console.log('❌ Critical issues found that must be fixed before deployment:\n');

    // Group by stage for clearer output
    const problemsByStage: Record<string, typeof criticalProblems> = {
      dev: [],
      secrets: [],
      staging: [],
      prod: [],
    };

    for (const problem of criticalProblems) {
      const stage = problem?.stage;
      if (stage && stage in problemsByStage) {
        const stageArray = problemsByStage[stage];
        if (stageArray) {
          stageArray.push(problem);
        }
      }
    }

    // Display each stage's critical problems
    for (const [stageName, stageProblems] of Object.entries(problemsByStage)) {
      if (stageProblems.length === 0) continue;

      console.log(`${stageName.toUpperCase()}:`);
      for (const problem of stageProblems) {
        console.log(`   ❌ ${problem.description}`);
        if (problem.manualFix) {
          console.log(`      💡 ${problem.manualFix}`);
        }
      }
      console.log('');
    }

    console.log('Please fix the issues above and try again.\n');
    return { success: false, error: 'Critical pre-deploy checks failed' };
  } else {
    console.log('✅ All pre-deploy checks passed!\n');
  }

  console.log('════════════════════════════════════════════════════════════');
  console.log(`🚀 DEPLOYING ${environment.toUpperCase()}`);
  console.log('════════════════════════════════════════════════════════════\n');

  // Load plugins and find pipeline plugin
  const plugins = await loadRelevantPlugins(rootDir, config);
  const PipelineClass = plugins.find((p) => p.category === 'pipeline') as unknown as PipelinePluginClass | undefined;

  if (!PipelineClass) {
    return { success: false, error: 'No pipeline plugin found' };
  }

  try {
    // Delegate to pipeline plugin - IT decides how to reach the stage
    const pipeline = new PipelineClass(config);
    // Note: Pass the stage (staging, prod) not the environment name (staging2, prod2)
    // The pipeline plugin handles routing based on stage
    const result = await pipeline.deployStage(stage, { ...options, rootDir, environment });

    if (result.success) {
      console.log(`\n✅ Deployment to ${environment} complete!`);
      if (result.message) {
        console.log(`   ${result.message}`);
      }
    } else {
      console.log(`\n❌ Deployment failed: ${result.error}`);
    }

    return result;
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.log(`\n❌ Deployment error: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

export default deploy;

