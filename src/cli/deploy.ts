/**
 * Deploy Command
 *
 * Deploys to specified environment
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

import { scan } from './scan.js';
import { loadRelevantPlugins } from '../plugins/index.js';
import type { FactiiiConfig, DeployOptions, DeployResult } from '../types/index.js';

interface PluginClass {
  id: string;
  category: string;
  new (config: FactiiiConfig): PluginInstance;
}

interface PluginInstance {
  deploy(config: FactiiiConfig, environment: string): Promise<DeployResult>;
  ensureServerReady?(
    config: FactiiiConfig,
    environment: string,
    options?: Record<string, string>
  ): Promise<DeployResult>;
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

export async function deploy(environment: string, options: DeployOptions = {}): Promise<DeployResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const config = loadConfig(rootDir);

  console.log(`🚀 Deploying to ${environment}...\n`);

  // First run scan to check for blocking issues
  const problems = await scan({ ...options, silent: true });

  // Check for critical issues
  const envProblems = problems[environment as keyof typeof problems] ?? [];
  const criticalIssues = envProblems.filter((p) => p.severity === 'critical');

  if (criticalIssues.length > 0) {
    console.log(`❌ Cannot deploy - ${criticalIssues.length} critical issue(s):`);
    for (const issue of criticalIssues) {
      console.log(`   • ${issue.description}`);
    }
    console.log('\n   Run: npx factiii fix\n');
    return { success: false, error: 'Critical issues found' };
  }

  // Load plugins and deploy
  const plugins = (await loadRelevantPlugins(rootDir, config)) as unknown as PluginClass[];

  // Find server plugin for this environment
  const serverPlugin = plugins.find((p) => p.category === 'server');

  if (!serverPlugin) {
    return { success: false, error: 'No server plugin found' };
  }

  try {
    const instance = new serverPlugin(config);

    // Ensure server is ready
    if (instance.ensureServerReady) {
      console.log('   Preparing server...');
      await instance.ensureServerReady(config, environment, {
        branch: options.branch ?? 'main',
        commitHash: options.commit ?? '',
      });
    }

    // Deploy
    const result = await instance.deploy(config, environment);

    if (result.success) {
      console.log(`\n✅ Deployment to ${environment} complete!`);
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

