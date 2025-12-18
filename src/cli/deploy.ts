/**
 * Deploy Command
 *
 * Deploys to specified environment by delegating to the pipeline plugin.
 * The pipeline plugin decides how to reach the stage (local vs workflow trigger).
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
 *
 * When --on-server flag is set, canReach checks are bypassed and deployment
 * executes directly on the current server.
 */
export async function deploy(environment: string, options: DeployOptions = {}): Promise<DeployResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const config = loadConfig(rootDir);

  console.log('════════════════════════════════════════════════════════════');
  console.log('🚀 FACTIII DEPLOY');
  console.log('════════════════════════════════════════════════════════════\n');

  console.log('📋 Stage 1: Running pre-deploy checks...\n');

  // First run scan to check for blocking issues
  // Pass onServer flag to skip canReach checks if we're already on the target server
  const problems = await scan({ ...options, silent: true, onServer: options.onServer });

  // Check for critical issues in the target environment
  const envProblems = problems[environment as keyof typeof problems] ?? [];
  const criticalIssues = envProblems.filter((p) => p.severity === 'critical');

  if (criticalIssues.length > 0) {
    console.log(`⚠️  Found ${criticalIssues.length} critical issue(s):`);
    for (const issue of criticalIssues) {
      console.log(`   • ${issue.description}`);
    }
    
    // Try to auto-fix critical issues
    console.log('\n🔧 Attempting to auto-fix issues...\n');
    
    let fixedCount = 0;
    for (const issue of criticalIssues) {
      if (issue.fix) {
        try {
          console.log(`   Fixing: ${issue.description}`);
          const fixed = await issue.fix(config, rootDir);
          if (fixed) {
            fixedCount++;
            console.log(`   ✅ Fixed: ${issue.description}`);
          } else {
            console.log(`   ❌ Could not fix: ${issue.description}`);
          }
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          console.log(`   ❌ Error fixing ${issue.description}: ${errorMessage}`);
        }
      }
    }
    
    if (fixedCount < criticalIssues.length) {
      console.log(`\n❌ Could not fix all critical issues (${fixedCount}/${criticalIssues.length} fixed)`);
      console.log('\n   Manual fixes required:');
      for (const issue of criticalIssues) {
        if (!issue.fix) {
          console.log(`   • ${issue.description}: ${issue.manualFix}`);
        }
      }
      return { success: false, error: 'Critical issues remain' };
    }
    
    console.log(`\n✅ All critical issues fixed (${fixedCount}/${criticalIssues.length})\n`);
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

