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
import { deploySecrets } from './deploy-secrets.js';
import { loadRelevantPlugins } from '../plugins/index.js';
import type { FactiiiConfig, DeployOptions, DeployResult, Stage } from '../types/index.js';
import { extractEnvironments, getStageFromEnvironment } from '../utils/config-helpers.js';

/**
 * Pipeline plugin class interface
 */
interface PipelinePluginClass {
  id: string;
  category: 'pipeline';
  new(config: FactiiiConfig): PipelinePluginInstance;
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
    console.error(`[!] Error parsing factiii.yml: ${errorMessage}`);
    return {} as FactiiiConfig;
  }
}

/**
 * Run a basic HTTP health check against the deployed domain
 */
async function runHealthCheck(domain: string): Promise<void> {
  console.log('\nRunning health check...');
  const url = 'https://' + domain;

  try {
    const https = await import('https');
    await new Promise<void>((resolve) => {
      const req = https.get(url, { timeout: 10000 }, (res) => {
        if (res.statusCode && res.statusCode < 500) {
          console.log('  [OK] ' + url + ' responded with status ' + res.statusCode);
        } else {
          console.log('  [!] ' + url + ' returned status ' + res.statusCode);
        }
        res.resume(); // consume response data
        resolve();
      });

      req.on('error', (e) => {
        console.log('  [!] Could not reach ' + url + ': ' + e.message);
        console.log('      Note: DNS or SSL may still be propagating');
        resolve();
      });

      req.on('timeout', () => {
        req.destroy();
        console.log('  [!] Health check timed out for ' + url);
        console.log('      Note: DNS or SSL may still be propagating');
        resolve();
      });
    });
  } catch {
    console.log('  [!] Health check skipped');
  }
}

/**
 * Print rollback/recovery instructions after a deployment failure
 */
function printRollbackInstructions(stage: Stage, environment: string, config: FactiiiConfig): void {
  const environments = extractEnvironments(config);
  const envConfig = environments[environment];
  const domain = envConfig?.domain ?? '<server>';
  const user = envConfig?.ssh_user ?? 'root';

  console.log('\nRECOVERY OPTIONS:\n');
  console.log('  1. View logs on server:');
  console.log('     ssh -i ~/.ssh/' + stage + '_deploy_key ' + user + '@' + domain + ' "docker logs --tail 50 \\$(docker ps -lq)"');
  console.log('\n  2. Rollback to previous commit:');
  console.log('     git log --oneline -5              # find working commit');
  console.log('     npx factiii deploy --' + stage + ' --commit <hash>');
  console.log('\n  3. Manual server access:');
  console.log('     ssh -i ~/.ssh/' + stage + '_deploy_key ' + user + '@' + domain);
  console.log('\n  4. Full reset:');
  console.log('     npx factiii undeploy --' + stage);
  console.log('     npx factiii deploy --' + stage + '\n');
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

  console.log('FACTIII DEPLOY\n');

  // ============================================================
  // CRITICAL: Environment Validation
  // ============================================================
  // Why this exists: Supports multiple environments per stage
  // What breaks if changed: Invalid environments could be deployed
  // Dependencies: extractEnvironments, getStageFromEnvironment
  // ============================================================

  // Map environment name to stage (staging2 -> staging, prod2 -> prod, etc.)
  // Do this FIRST because 'dev' and 'secrets' don't require environment configs
  let stage: Stage;
  try {
    stage = getStageFromEnvironment(environment);
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.log(`[ERROR] ${errorMessage}`);
    return { success: false, error: errorMessage };
  }

  // Special stages (dev, secrets) don't require environment configuration
  // They run locally and don't need server configs
  if (stage !== 'dev' && stage !== 'secrets') {
    // Validate environment exists in config (only for staging/prod)
    const environments = extractEnvironments(config);

    if (!environments[environment]) {
      const available = Object.keys(environments).join(', ');
      console.log(`[ERROR] Environment '${environment}' not found in config.`);
      console.log(`   Available environments: ${available || 'none'}`);
      return {
        success: false,
        error: `Environment '${environment}' not found. Available: ${available}`,
      };
    }
  }

  console.log(`Environment: ${environment} (${stage} stage)\n`);

  // Deploy secrets if --secrets flag is passed
  if (options.deploySecrets && (stage === 'staging' || stage === 'prod')) {
    console.log('Stage 0: Deploying secrets...\n');
    const secretsResult = await deploySecrets(stage, { rootDir });
    if (!secretsResult.success) {
      console.log('[ERROR] Secrets deployment failed: ' + (secretsResult.error ?? 'Unknown error'));
      return { success: false, error: 'Secrets deployment failed: ' + (secretsResult.error ?? 'Unknown error') };
    }
    console.log('[OK] Secrets deployed\n');
  }

  console.log('Stage 1: Running pre-deploy checks...\n');

  // First run scan to check for blocking issues
  // Only scan the target stage - don't let prod issues block a staging deploy
  // Clear stage flags from options so they don't override the stages array
  // (e.g., --secrets sets options.secrets=true which scan interprets as "scan secrets stage only")
  const scanOptions = { ...options, silent: true, stages: [stage] as Stage[] };
  delete scanOptions.dev;
  delete scanOptions.secrets;
  delete scanOptions.staging;
  delete scanOptions.prod;
  delete scanOptions.deploySecrets;
  const problems = await scan(scanOptions);

  // Only block on CRITICAL issues - warnings/info will be auto-fixed during deployment
  const criticalProblems = Object.values(problems)
    .flat()
    .filter(fix => fix && fix.severity === 'critical');

  if (criticalProblems.length > 0) {
    console.log('[ERROR] Critical issues found that must be fixed before deployment:\n');

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
        console.log(`  [ERROR] ${problem.description}`);
        if (problem.manualFix) {
          console.log(`    Hint: ${problem.manualFix}`);
        }
      }
      console.log('');
    }

    console.log('Please fix the issues above and try again.\n');
    return { success: false, error: 'Critical pre-deploy checks failed' };
  } else {
    console.log('[OK] All pre-deploy checks passed!\n');
  }

  // Dry run: show deployment plan without executing
  if (options.dryRun) {
    console.log('[DRY RUN] Deployment plan:\n');
    console.log('  Environment: ' + environment);
    console.log('  Stage:       ' + stage);

    if (stage !== 'dev' && stage !== 'secrets') {
      const environments = extractEnvironments(config);
      const envConfig = environments[environment];
      if (envConfig) {
        console.log('  Domain:      ' + (envConfig.domain ?? 'N/A'));
        console.log('  Server:      ' + (envConfig.server ?? 'N/A'));
        console.log('  SSH User:    ' + (envConfig.ssh_user ?? 'root'));
      }
    }

    console.log('\n[DRY RUN] All pre-deploy checks passed. Run without --dry-run to execute:\n');
    console.log('  npx factiii deploy --' + stage + '\n');
    return { success: true, message: 'Dry run completed' };
  }

  console.log(`DEPLOYING ${environment.toUpperCase()}\n`);

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
      console.log(`\n[OK] Deployment to ${environment} complete!`);
      if (result.message) {
        console.log(`  ${result.message}`);
      }

      // Post-deploy health check for staging/prod
      if (stage === 'staging' || stage === 'prod') {
        const environments = extractEnvironments(config);
        const envConfig = environments[environment];
        if (envConfig?.domain) {
          await runHealthCheck(envConfig.domain);
        }
      }
    } else {
      console.log(`\n[ERROR] Deployment failed: ${result.error}`);
      printRollbackInstructions(stage, environment, config);
    }

    return result;
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.log(`\n[ERROR] Deployment error: ${errorMessage}`);
    printRollbackInstructions(stage, environment, config);
    return { success: false, error: errorMessage };
  }
}

export default deploy;

