/**
 * Plugin Registry and Loader
 * 
 * Central registry for all Factiii Stack plugins.
 * Loads plugins from the new structure:
 *   - pipelines/
 *   - servers/
 *   - frameworks/
 *   - addons/
 */

// Approved plugins list (for external plugin warnings)
const APPROVED_PLUGINS = require('./approved.json');

// ============================================================
// PLUGIN REGISTRY
// ============================================================

/**
 * Central registry for all plugins
 * 4 categories: pipelines, servers, frameworks, addons
 */
const registry = {
  pipelines: {},
  servers: {},
  frameworks: {},
  addons: {},
  // Legacy categories (for backwards compatibility)
  secrets: {},
  server: {},
  app: {}
};

// ============================================================
// LOAD BUILT-IN PLUGINS
// ============================================================

// Pipeline plugins
try {
  const FactiiiPipeline = require('./pipelines/factiii');
  registry.pipelines['factiii'] = FactiiiPipeline;
} catch (e) {
  // Plugin not available
}

// Server plugins (new structure)
try {
  const MacMiniPlugin = require('./servers/mac-mini');
  registry.servers['mac-mini'] = MacMiniPlugin;
} catch (e) {
  // Plugin not available
}

try {
  const AWSPlugin = require('./servers/aws');
  registry.servers['aws'] = AWSPlugin;
} catch (e) {
  // Plugin not available
}

// Framework plugins
try {
  const PrismaTrpcPlugin = require('./frameworks/prisma-trpc');
  registry.frameworks['prisma-trpc'] = PrismaTrpcPlugin;
} catch (e) {
  // Plugin not available
}

// Note: Legacy secrets plugin removed - GitHub secrets now handled by pipeline plugin

// ============================================================
// REGISTRATION FUNCTIONS
// ============================================================

/**
 * Register a plugin
 * @param {Object} PluginClass - Plugin class to register
 */
function registerPlugin(PluginClass) {
  const category = PluginClass.category;
  const id = PluginClass.id;
  
  if (!category || !id) {
    throw new Error('Plugin must have static id and category properties');
  }
  
  // Map old categories to new ones
  const categoryMap = {
    'pipeline': 'pipelines',
    'server': 'servers',
    'framework': 'frameworks',
    'addon': 'addons',
    'secrets': 'secrets'
  };
  
  const normalizedCategory = categoryMap[category] || category;
  
  if (!registry[normalizedCategory]) {
    registry[normalizedCategory] = {};
  }
  
  registry[normalizedCategory][id] = PluginClass;
  return PluginClass;
}

/**
 * Register multiple plugins at once
 */
function registerPlugins(plugins) {
  for (const plugin of plugins) {
    registerPlugin(plugin);
  }
}

// ============================================================
// RETRIEVAL FUNCTIONS
// ============================================================

/**
 * Get a plugin by category and ID
 */
function getPlugin(category, id) {
  // Map old categories to new ones
  const categoryMap = {
    'pipeline': 'pipelines',
    'server': 'servers',
    'framework': 'frameworks',
    'addon': 'addons'
  };
  
  const normalizedCategory = categoryMap[category] || category;
  
  if (!registry[normalizedCategory]) {
    console.warn(`Unknown plugin category: ${category}`);
    return null;
  }
  
  return registry[normalizedCategory][id] || null;
}

/**
 * Get all plugins in a category
 */
function getPluginsByCategory(category) {
  const categoryMap = {
    'pipeline': 'pipelines',
    'server': 'servers',
    'framework': 'frameworks',
    'addon': 'addons'
  };
  
  const normalizedCategory = categoryMap[category] || category;
  return registry[normalizedCategory] || {};
}

/**
 * Get all loaded plugins as instances
 */
function loadAllPlugins() {
  const plugins = [];
  
  for (const category of ['pipelines', 'servers', 'frameworks', 'addons']) {
    for (const [id, PluginClass] of Object.entries(registry[category] || {})) {
      plugins.push(PluginClass);
    }
  }
  
  return plugins;
}

/**
 * Get a list of all registered plugins
 */
function listPlugins() {
  const plugins = [];
  
  for (const [category, categoryPlugins] of Object.entries(registry)) {
    for (const [id, PluginClass] of Object.entries(categoryPlugins)) {
      plugins.push({
        id,
        category,
        name: PluginClass.name,
        version: PluginClass.version || '1.0.0'
      });
    }
  }
  
  return plugins;
}

// ============================================================
// INSTANCE CREATION
// ============================================================

/**
 * Create a plugin instance
 */
function createPluginInstance(category, id, config = {}, secrets = {}) {
  const PluginClass = getPlugin(category, id);
  
  if (!PluginClass) {
    console.warn(`Plugin not found: ${category}/${id}`);
    return null;
  }
  
  return new PluginClass(config, secrets);
}

/**
 * Create a secret store instance (legacy)
 */
function createSecretStore(id, config = {}) {
  const PluginClass = registry.secrets[id];
  
  if (!PluginClass) {
    console.warn(`Secret store not found: ${id}`);
    return null;
  }
  
  return new PluginClass(config);
}

// ============================================================
// EXTERNAL PLUGIN LOADING
// ============================================================

/**
 * Check if a plugin is approved
 */
function isApprovedPlugin(packageName) {
  return APPROVED_PLUGINS.approved.includes(packageName);
}

/**
 * Load external plugins from npm packages
 */
function loadExternalPlugins(packageNames = [], trustedPlugins = []) {
  for (const packageName of packageNames) {
    const isApproved = isApprovedPlugin(packageName);
    const isTrusted = trustedPlugins.includes(packageName);
    
    if (!isApproved && !isTrusted) {
      console.warn(`⚠️  Loading unapproved plugin: ${packageName}`);
    }
    
    try {
      const pluginModule = require(packageName);
      
      if (pluginModule.category && pluginModule.id) {
        registerPlugin(pluginModule);
      } else if (pluginModule.plugins) {
        registerPlugins(pluginModule.plugins);
      }
      
      const approvalStatus = isApproved ? '✅' : (isTrusted ? '🔓' : '⚠️');
      console.log(`${approvalStatus} Loaded external plugin: ${packageName}`);
    } catch (error) {
      console.warn(`❌ Failed to load external plugin ${packageName}: ${error.message}`);
    }
  }
}

// ============================================================
// SMART PLUGIN LOADING
// ============================================================

/**
 * Load only relevant plugins based on project detection
 * Each plugin's shouldLoad() method determines if it's relevant
 * 
 * @param {string} rootDir - Project root directory
 * @param {Object} config - Existing config (if any)
 * @returns {Promise<Array>} - Array of relevant plugin classes
 */
async function loadRelevantPlugins(rootDir, config = {}) {
  const plugins = [];
  
  for (const category of ['pipelines', 'servers', 'frameworks', 'addons']) {
    for (const [id, PluginClass] of Object.entries(registry[category] || {})) {
      // Check if plugin should load
      if (PluginClass.shouldLoad) {
        try {
          const shouldLoad = await PluginClass.shouldLoad(rootDir, config);
          if (shouldLoad) {
            plugins.push(PluginClass);
          }
        } catch (e) {
          console.warn(`Warning: Error checking shouldLoad for ${id}: ${e.message}`);
          // On error, don't load the plugin
        }
      } else {
        // No shouldLoad method = always load (backwards compatibility)
        plugins.push(PluginClass);
      }
    }
  }
  
  return plugins;
}

// ============================================================
// SCHEMA COLLECTION METHODS
// ============================================================

/**
 * Collect all config schemas from plugins
 * @returns {Object} Merged config schema from all plugins
 */
function collectConfigSchemas() {
  const schema = {};
  
  for (const category of ['pipelines', 'servers', 'frameworks', 'addons']) {
    for (const [id, PluginClass] of Object.entries(registry[category] || {})) {
      if (PluginClass.configSchema) {
        Object.assign(schema, PluginClass.configSchema);
      }
    }
  }
  
  return schema;
}

/**
 * Collect all auto config schemas from plugins
 * @returns {Object} Merged auto config schema from all plugins
 */
function collectAutoConfigSchemas() {
  const schema = {};
  
  for (const category of ['pipelines', 'servers', 'frameworks', 'addons']) {
    for (const [id, PluginClass] of Object.entries(registry[category] || {})) {
      if (PluginClass.autoConfigSchema) {
        Object.assign(schema, PluginClass.autoConfigSchema);
      }
    }
  }
  
  return schema;
}

/**
 * Run detectConfig on all plugins
 * @param {string} rootDir - Root directory to scan
 * @returns {Promise<Object>} Merged detected config from all plugins
 */
async function detectAllConfigs(rootDir) {
  const config = {};
  
  for (const category of ['pipelines', 'servers', 'frameworks', 'addons']) {
    for (const [id, PluginClass] of Object.entries(registry[category] || {})) {
      if (PluginClass.detectConfig) {
        try {
          const detected = await PluginClass.detectConfig(rootDir);
          if (detected) {
            Object.assign(config, detected);
          }
        } catch (e) {
          console.warn(`Warning: Failed to detect config for ${id}: ${e.message}`);
        }
      }
    }
  }
  
  return config;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Registry functions
  registerPlugin,
  registerPlugins,
  getPlugin,
  getPluginsByCategory,
  listPlugins,
  loadAllPlugins,
  loadRelevantPlugins,
  
  // Instance creation
  createPluginInstance,
  createSecretStore,
  
  // External plugins
  loadExternalPlugins,
  isApprovedPlugin,
  
  // Schema collection
  collectConfigSchemas,
  collectAutoConfigSchemas,
  detectAllConfigs,
  
  // Direct access to registries
  registry,
  
  // Legacy exports for backwards compatibility
  plugins: {
    pipelines: registry.pipelines,
    servers: registry.servers,
    frameworks: registry.frameworks,
    addons: registry.addons,
    secrets: registry.secrets
  }
};
