/**
 * Plugin Registry and Loader
 * 
 * Central registry for all Factiii Stack plugins.
 * Handles loading, registration, and retrieval of plugins.
 */

// Import interfaces
const { 
  ServerProvider, 
  SecretStore, 
  RegistryProvider, 
  AppFramework,
  Addon,
  Pipeline
} = require('./interfaces');

// Import built-in plugins
const { GitHubSecretsStore } = require('./secrets/github');
const MacMiniProvider = require('./server/mac-mini');
const AWSEC2Provider = require('./server/aws-ec2');

// Approved plugins list (for external plugin warnings)
const APPROVED_PLUGINS = require('./approved.json');

// ============================================================
// PLUGIN REGISTRY
// ============================================================

/**
 * Central registry for all plugins
 * 5 categories: secrets, server, app (framework), addon, pipeline
 */
const registry = {
  server: {},
  secrets: {},
  registry: {},
  app: {},
  addon: {},
  pipeline: {}
};

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
  
  if (!registry[category]) {
    throw new Error(`Unknown plugin category: ${category}`);
  }
  
  registry[category][id] = PluginClass;
  return PluginClass;
}

/**
 * Register multiple plugins at once
 * @param {Object[]} plugins - Array of plugin classes
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
 * @param {string} category - Plugin category (server, secrets, registry, app)
 * @param {string} id - Plugin ID
 * @returns {Object|null} Plugin class or null if not found
 */
function getPlugin(category, id) {
  if (!registry[category]) {
    console.warn(`Unknown plugin category: ${category}`);
    return null;
  }
  
  return registry[category][id] || null;
}

/**
 * Get all plugins in a category
 * @param {string} category - Plugin category
 * @returns {Object} Map of plugin ID to plugin class
 */
function getPluginsByCategory(category) {
  return registry[category] || {};
}

/**
 * Get a list of all registered plugins
 * @returns {Object[]} Array of plugin info objects
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
 * @param {string} category - Plugin category
 * @param {string} id - Plugin ID
 * @param {Object} config - Configuration to pass to constructor
 * @param {Object} secrets - Secrets to pass to constructor
 * @returns {Object|null} Plugin instance or null if not found
 */
function createPluginInstance(category, id, config = {}, secrets = {}) {
  const PluginClass = getPlugin(category, id);
  
  if (!PluginClass) {
    console.warn(`Plugin not found: ${category}/${id}`);
    return null;
  }
  
  // Different constructors for different categories
  if (category === 'secrets') {
    return new PluginClass(config);
  } else if (category === 'app') {
    return new PluginClass(config.path, config);
  } else {
    return new PluginClass(config, secrets);
  }
}

/**
 * Create a server provider instance
 * @param {string} id - Server provider ID (e.g., 'mac-mini', 'aws-ec2')
 * @param {Object} config - Server configuration
 * @param {Object} secrets - SSH and other secrets
 * @returns {ServerProvider|null}
 */
function createServerProvider(id, config = {}, secrets = {}) {
  return createPluginInstance('server', id, config, secrets);
}

/**
 * Create a secret store instance
 * @param {string} id - Secret store ID (e.g., 'github')
 * @param {Object} config - Store configuration (token, owner, repo, etc.)
 * @returns {SecretStore|null}
 */
function createSecretStore(id, config = {}) {
  return createPluginInstance('secrets', id, config);
}

// ============================================================
// EXTERNAL PLUGIN LOADING
// ============================================================

/**
 * Check if a plugin is approved
 * @param {string} packageName - npm package name
 * @returns {boolean}
 */
function isApprovedPlugin(packageName) {
  return APPROVED_PLUGINS.approved.includes(packageName);
}

/**
 * Load external plugins from npm packages
 * @param {string[]} packageNames - Array of npm package names
 * @param {string[]} trustedPlugins - Additional trusted plugins (from factiii.yml)
 */
function loadExternalPlugins(packageNames = [], trustedPlugins = []) {
  for (const packageName of packageNames) {
    // Check if plugin is approved or trusted
    const isApproved = isApprovedPlugin(packageName);
    const isTrusted = trustedPlugins.includes(packageName);
    
    if (!isApproved && !isTrusted) {
      console.warn(`⚠️  Loading unapproved plugin: ${packageName}`);
      console.warn(`   This plugin has not been validated by the Factiii team.`);
      console.warn(`   Use at your own risk. To suppress: add to factiii.yml trusted_plugins list.`);
      console.warn('');
    }
    
    try {
      const pluginModule = require(packageName);
      
      // Check if module exports a single plugin or multiple
      if (pluginModule.category && pluginModule.id) {
        // Single plugin
        registerPlugin(pluginModule);
      } else if (pluginModule.plugins) {
        // Multiple plugins
        registerPlugins(pluginModule.plugins);
      } else if (typeof pluginModule === 'object') {
        // Try to find plugin classes in exports
        for (const key of Object.keys(pluginModule)) {
          const exported = pluginModule[key];
          if (exported?.category && exported?.id) {
            registerPlugin(exported);
          }
        }
      }
      
      const approvalStatus = isApproved ? '✅' : (isTrusted ? '🔓' : '⚠️');
      console.log(`${approvalStatus} Loaded external plugin: ${packageName}`);
    } catch (error) {
      console.warn(`❌ Failed to load external plugin ${packageName}: ${error.message}`);
    }
  }
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Get required secrets for a server plugin
 * @param {string} serverId - Server plugin ID
 * @param {string} environment - Environment name (for prefixing)
 * @returns {Array<Object>} Array of secret definitions with environment-specific names
 */
function getServerSecrets(serverId, environment) {
  const ServerClass = getPlugin('server', serverId);
  
  if (!ServerClass) {
    return [];
  }
  
  return ServerClass.getSecretsForEnvironment(environment);
}

/**
 * Get help text for a server plugin secret
 * @param {string} serverId - Server plugin ID
 * @param {string} secretName - Secret name (without environment prefix)
 * @returns {string|null}
 */
function getServerSecretHelpText(serverId, secretName) {
  const ServerClass = getPlugin('server', serverId);
  
  if (!ServerClass?.helpText) {
    return null;
  }
  
  return ServerClass.helpText[secretName] || null;
}

// ============================================================
// REGISTER BUILT-IN PLUGINS
// ============================================================

// Server providers
registerPlugin(MacMiniProvider);
registerPlugin(AWSEC2Provider);

// Secret stores
registerPlugin(GitHubSecretsStore);

// Registry providers (TODO)
// registerPlugin(ECRProvider);

// App frameworks (TODO)
// registerPlugin(NextJSFramework);
// registerPlugin(ExpoFramework);

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Interfaces
  interfaces: {
    ServerProvider,
    SecretStore,
    RegistryProvider,
    AppFramework,
    Addon,
    Pipeline
  },
  
  // Registry functions
  registerPlugin,
  registerPlugins,
  getPlugin,
  getPluginsByCategory,
  listPlugins,
  
  // Instance creation
  createPluginInstance,
  createServerProvider,
  createSecretStore,
  
  // External plugins
  loadExternalPlugins,
  isApprovedPlugin,
  
  // Helpers
  getServerSecrets,
  getServerSecretHelpText,
  
  // Direct access to built-in plugins
  plugins: {
    server: {
      MacMiniProvider,
      AWSEC2Provider
    },
    secrets: {
      GitHubSecretsStore
    }
  }
};

