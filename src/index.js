/**
 * Factiii Stack Infrastructure Package
 * Main entry point for programmatic usage
 */

// Plugin system
const plugins = require('./plugins');

// Server-side generators
const { scanRepos, loadConfigs, generateDockerCompose, generateNginx } = require('./scripts/generate-all');

module.exports = {
  // Plugin system exports
  plugins,
  
  // Plugin interfaces
  interfaces: plugins.interfaces,
  
  // Plugin registry functions
  registerPlugin: plugins.registerPlugin,
  getPlugin: plugins.getPlugin,
  listPlugins: plugins.listPlugins,
  createServerProvider: plugins.createServerProvider,
  createSecretStore: plugins.createSecretStore,
  
  // Server-side generators (used on deployment servers)
  scanRepos,
  loadConfigs,
  generateDockerCompose,
  generateNginx
};
