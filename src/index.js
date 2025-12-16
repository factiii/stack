/**
 * Factiii Stack Infrastructure Package
 * Main entry point for programmatic usage
 */

// Plugin system
const plugins = require('./plugins');

// Generators
const mergeConfigs = require('./generators/merge-configs');
const generateCompose = require('./generators/generate-compose');
const generateNginx = require('./generators/generate-nginx');

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
  
  // Generators
  mergeConfigs,
  generateCompose,
  generateNginx
};
