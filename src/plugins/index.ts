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

import type { FactiiiConfig, PluginCategory, PluginMetadata } from '../types/index.js';

// Approved plugins list (for external plugin warnings)
import * as fs from 'fs';
import * as path from 'path';

// Try to load approved.json, fall back to empty list if not found
let APPROVED_PLUGINS: { approved: string[] } = { approved: [] };
try {
  const approvedPath = path.join(__dirname, 'approved.json');
  if (fs.existsSync(approvedPath)) {
    APPROVED_PLUGINS = JSON.parse(
      fs.readFileSync(approvedPath, 'utf8')
    ) as { approved: string[] };
  }
} catch {
  // File not found or invalid - use empty list
  APPROVED_PLUGINS = { approved: [] };
}

// ============================================================
// TYPE DEFINITIONS
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface PluginClass {
  id: string;
  name: string;
  category: PluginCategory;
  version: string;
  configSchema?: Record<string, unknown>;
  autoConfigSchema?: Record<string, string>;
  shouldLoad?: (rootDir: string, config: FactiiiConfig) => Promise<boolean>;
  detectConfig?: (rootDir: string) => Promise<Record<string, unknown> | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new (config: FactiiiConfig, secrets?: Record<string, unknown>): any;
}

export interface PluginRegistry {
  pipelines: Record<string, PluginClass>;
  servers: Record<string, PluginClass>;
  frameworks: Record<string, PluginClass>;
  addons: Record<string, PluginClass>;
  secrets: Record<string, PluginClass>;
  server: Record<string, PluginClass>;
  app: Record<string, PluginClass>;
}

// ============================================================
// PLUGIN REGISTRY
// ============================================================

/**
 * Central registry for all plugins
 * 4 categories: pipelines, servers, frameworks, addons
 */
export const registry: PluginRegistry = {
  pipelines: {},
  servers: {},
  frameworks: {},
  addons: {},
  // Legacy categories (for backwards compatibility)
  secrets: {},
  server: {},
  app: {},
};

// ============================================================
// LOAD BUILT-IN PLUGINS
// ============================================================

// Load plugins synchronously using require
// Pipeline plugins
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const FactiiiPipeline = require('./pipelines/factiii/index').default as PluginClass;
  registry.pipelines['factiii'] = FactiiiPipeline;
} catch {
  // Plugin not available
}

// Server plugins (new structure)
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const MacMiniPlugin = require('./servers/mac-mini/index').default as PluginClass;
  registry.servers['mac-mini'] = MacMiniPlugin;
} catch {
  // Plugin not available
}

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AWSPlugin = require('./servers/aws/index').default as PluginClass;
  registry.servers['aws'] = AWSPlugin;
} catch {
  // Plugin not available
}

// Framework plugins
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const PrismaTrpcPlugin = require('./frameworks/prisma-trpc/index').default as PluginClass;
  registry.frameworks['prisma-trpc'] = PrismaTrpcPlugin;
} catch {
  // Plugin not available
}

// ============================================================
// REGISTRATION FUNCTIONS
// ============================================================

const categoryMap: Record<string, keyof PluginRegistry> = {
  pipeline: 'pipelines',
  server: 'servers',
  framework: 'frameworks',
  addon: 'addons',
  secrets: 'secrets',
};

/**
 * Register a plugin
 */
export function registerPlugin(PluginClass: PluginClass): PluginClass {
  const category = PluginClass.category;
  const id = PluginClass.id;

  if (!category || !id) {
    throw new Error('Plugin must have static id and category properties');
  }

  const normalizedCategory = categoryMap[category] ?? category;

  if (!registry[normalizedCategory as keyof PluginRegistry]) {
    (registry as unknown as Record<string, Record<string, PluginClass>>)[normalizedCategory] = {};
  }

  registry[normalizedCategory as keyof PluginRegistry][id] = PluginClass;
  return PluginClass;
}

/**
 * Register multiple plugins at once
 */
export function registerPlugins(plugins: PluginClass[]): void {
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
export function getPlugin(
  category: string,
  id: string
): PluginClass | null {
  const normalizedCategory = categoryMap[category] ?? category;

  const categoryRegistry = registry[normalizedCategory as keyof PluginRegistry];
  if (!categoryRegistry) {
    console.warn(`Unknown plugin category: ${category}`);
    return null;
  }

  return categoryRegistry[id] ?? null;
}

/**
 * Get all plugins in a category
 */
export function getPluginsByCategory(
  category: string
): Record<string, PluginClass> {
  const normalizedCategory = categoryMap[category] ?? category;
  return registry[normalizedCategory as keyof PluginRegistry] ?? {};
}

/**
 * Get all loaded plugins as classes
 */
export function loadAllPlugins(): PluginClass[] {
  const plugins: PluginClass[] = [];

  for (const category of ['pipelines', 'servers', 'frameworks', 'addons'] as const) {
    for (const pluginClass of Object.values(registry[category])) {
      plugins.push(pluginClass);
    }
  }

  return plugins;
}

/**
 * Get a list of all registered plugins
 */
export function listPlugins(): PluginMetadata[] {
  const plugins: PluginMetadata[] = [];

  for (const [category, categoryPlugins] of Object.entries(registry)) {
    for (const [id, pluginClass] of Object.entries(categoryPlugins as Record<string, PluginClass>)) {
      plugins.push({
        id,
        category,
        name: pluginClass.name,
        version: pluginClass.version ?? '1.0.0',
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
export function createPluginInstance(
  category: string,
  id: string,
  config: FactiiiConfig = {} as FactiiiConfig,
  secrets: Record<string, unknown> = {}
): unknown {
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
export function createSecretStore(
  id: string,
  config: FactiiiConfig = {} as FactiiiConfig
): unknown {
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
export function isApprovedPlugin(packageName: string): boolean {
  return APPROVED_PLUGINS.approved.includes(packageName);
}

/**
 * Load external plugins from npm packages
 */
export function loadExternalPlugins(
  packageNames: string[] = [],
  trustedPlugins: string[] = []
): void {
  for (const packageName of packageNames) {
    const isApproved = isApprovedPlugin(packageName);
    const isTrusted = trustedPlugins.includes(packageName);

    if (!isApproved && !isTrusted) {
      console.warn(`⚠️  Loading unapproved plugin: ${packageName}`);
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pluginModule = require(packageName) as
        | PluginClass
        | { plugins: PluginClass[] };

      if ('category' in pluginModule && 'id' in pluginModule) {
        registerPlugin(pluginModule as PluginClass);
      } else if ('plugins' in pluginModule) {
        registerPlugins(pluginModule.plugins);
      }

      const approvalStatus = isApproved ? '✅' : isTrusted ? '🔓' : '⚠️';
      console.log(`${approvalStatus} Loaded external plugin: ${packageName}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`❌ Failed to load external plugin ${packageName}: ${errorMessage}`);
    }
  }
}

// ============================================================
// SMART PLUGIN LOADING
// ============================================================

/**
 * Load only relevant plugins based on project detection
 * Each plugin's shouldLoad() method determines if it's relevant
 */
export async function loadRelevantPlugins(
  rootDir: string,
  config: FactiiiConfig = {} as FactiiiConfig
): Promise<PluginClass[]> {
  const plugins: PluginClass[] = [];

  for (const category of ['pipelines', 'servers', 'frameworks', 'addons'] as const) {
    for (const [id, PluginClass] of Object.entries(registry[category])) {
      // Check if plugin should load
      if (PluginClass.shouldLoad) {
        try {
          const shouldLoad = await PluginClass.shouldLoad(rootDir, config);
          if (shouldLoad) {
            plugins.push(PluginClass);
          }
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          console.warn(`Warning: Error checking shouldLoad for ${id}: ${errorMessage}`);
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
 */
export function collectConfigSchemas(): Record<string, unknown> {
  const schema: Record<string, unknown> = {};

  for (const category of ['pipelines', 'servers', 'frameworks', 'addons'] as const) {
    for (const PluginClass of Object.values(registry[category])) {
      if (PluginClass.configSchema) {
        Object.assign(schema, PluginClass.configSchema);
      }
    }
  }

  return schema;
}

/**
 * Collect all auto config schemas from plugins
 */
export function collectAutoConfigSchemas(): Record<string, string> {
  const schema: Record<string, string> = {};

  for (const category of ['pipelines', 'servers', 'frameworks', 'addons'] as const) {
    for (const PluginClass of Object.values(registry[category])) {
      if (PluginClass.autoConfigSchema) {
        Object.assign(schema, PluginClass.autoConfigSchema);
      }
    }
  }

  return schema;
}

/**
 * Run detectConfig on all plugins
 */
export async function detectAllConfigs(
  rootDir: string
): Promise<Record<string, unknown>> {
  const config: Record<string, unknown> = {};

  for (const category of ['pipelines', 'servers', 'frameworks', 'addons'] as const) {
    for (const [id, PluginClass] of Object.entries(registry[category])) {
      if (PluginClass.detectConfig) {
        try {
          const detected = await PluginClass.detectConfig(rootDir);
          if (detected) {
            Object.assign(config, detected);
          }
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          console.warn(`Warning: Failed to detect config for ${id}: ${errorMessage}`);
        }
      }
    }
  }

  return config;
}

// ============================================================
// LEGACY EXPORTS
// ============================================================

export const plugins = {
  pipelines: registry.pipelines,
  servers: registry.servers,
  frameworks: registry.frameworks,
  addons: registry.addons,
  secrets: registry.secrets,
};

