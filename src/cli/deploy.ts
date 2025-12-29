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

  console.log('📋 Stage 1: Running pre-deploy checks...\n');

  // First run scan to check for blocking issues
  const problems = await scan({ ...options, silent: true });
  if (Object.values(problems).flat().filter(Boolean).length > 0) {
    console.log('❌ Pre-deploy checks failed. Please fix the issues and try again.');
    return { success: false, error: 'Pre-deploy checks failed' };
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
    const result = await pipeline.deployStage(environment as Stage, { ...options, rootDir });

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

