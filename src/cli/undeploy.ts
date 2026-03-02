/**
 * Undeploy Command
 *
 * Removes deployment from specified environment
 */

import { loadRelevantPlugins } from '../plugins/index.js';
import { loadConfig } from '../utils/config-helpers.js';
import type { FactiiiConfig, UndeployOptions, DeployResult } from '../types/index.js';

interface PluginClass {
  id: string;
  category: string;
  new(config: FactiiiConfig): PluginInstance;
}

interface PluginInstance {
  undeploy(config: FactiiiConfig, environment: string): Promise<DeployResult>;
}

export async function undeploy(environment: string, options: UndeployOptions = {}): Promise<DeployResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const config = loadConfig(rootDir);

  console.log(`Removing ${environment} deployment...\n`);

  // Load plugins
  const plugins = (await loadRelevantPlugins(rootDir, config)) as unknown as PluginClass[];

  // Find server plugin for this environment
  const serverPlugin = plugins.find((p) => p.category === 'server');

  if (!serverPlugin) {
    return { success: false, error: 'No server plugin found' };
  }

  try {
    const instance = new serverPlugin(config);
    const result = await instance.undeploy(config, environment);

    if (result.success) {
      console.log(`\n[OK] Successfully removed ${environment} deployment`);
    } else {
      console.log(`\n[ERROR] Undeploy failed: ${result.error}`);
    }

    return result;
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.log(`\n[ERROR] Undeploy error: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

export default undeploy;

