/**
 * Factiii Stack Infrastructure Package
 * Main entry point for programmatic usage
 */

// Plugin system
import * as plugins from './plugins/index.js';

// Server-side generators
import {
  scanRepos,
  loadConfigs,
  generateDockerCompose,
  generateNginx,
} from './scripts/generate-all.js';

// Re-export plugin interfaces
export { PipelinePlugin } from './plugins/interfaces/pipeline.js';
export { ServerPlugin } from './plugins/interfaces/server.js';
export { FrameworkPlugin } from './plugins/interfaces/framework.js';
export { AddonPlugin } from './plugins/interfaces/addon.js';

// Re-export types
export * from './types/index.js';

// Export plugin registry functions
export const registerPlugin = plugins.registerPlugin;
export const getPlugin = plugins.getPlugin;
export const getPluginsByCategory = plugins.getPluginsByCategory;
export const listPlugins = plugins.listPlugins;
export const loadAllPlugins = plugins.loadAllPlugins;
export const loadRelevantPlugins = plugins.loadRelevantPlugins;
export const createPluginInstance = plugins.createPluginInstance;
export const createSecretStore = plugins.createSecretStore;
export const loadExternalPlugins = plugins.loadExternalPlugins;
export const isApprovedPlugin = plugins.isApprovedPlugin;
export const collectConfigSchemas = plugins.collectConfigSchemas;
export const collectAutoConfigSchemas = plugins.collectAutoConfigSchemas;
export const detectAllConfigs = plugins.detectAllConfigs;
export const registry = plugins.registry;

// Export server-side generators (used on deployment servers)
export { scanRepos, loadConfigs, generateDockerCompose, generateNginx };

// Default export for compatibility
export default {
  plugins,
  registerPlugin: plugins.registerPlugin,
  getPlugin: plugins.getPlugin,
  listPlugins: plugins.listPlugins,
  createSecretStore: plugins.createSecretStore,
  scanRepos,
  loadConfigs,
  generateDockerCompose,
  generateNginx,
};

