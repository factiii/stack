/**
 * Generate factiii.yml
 *
 * Generates the factiii.yml configuration file from plugin schemas.
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

import type { FactiiiConfig } from '../types/index.js';

interface PluginWithSchema {
  configSchema?: Record<string, unknown>;
}

interface GenerateOptions {
  force?: boolean;
  plugins?: PluginWithSchema[];
}

/**
 * Load all plugins
 */
function loadAllPlugins(): PluginWithSchema[] {
  const plugins: PluginWithSchema[] = [];

  // Load pipeline plugins
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const FactiiiPipeline = require('../plugins/pipelines/factiii') as PluginWithSchema;
    plugins.push(FactiiiPipeline);
  } catch {
    // Plugin not available
  }

  // Load server plugins
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const MacMiniPlugin = require('../plugins/servers/mac-mini') as PluginWithSchema;
    plugins.push(MacMiniPlugin);
  } catch {
    // Plugin not available
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AWSPlugin = require('../plugins/servers/aws') as PluginWithSchema;
    plugins.push(AWSPlugin);
  } catch {
    // Plugin not available
  }

  // Load framework plugins
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const PrismaTrpcPlugin = require('../plugins/frameworks/prisma-trpc') as PluginWithSchema;
    plugins.push(PrismaTrpcPlugin);
  } catch {
    // Plugin not available
  }

  return plugins;
}

/**
 * Generate factiii.yml template from plugin schemas
 * @param plugins - Optional array of plugin classes to use
 */
export function generateFactiiiYmlTemplate(plugins: PluginWithSchema[] | null = null): string {
  const actualPlugins = plugins ?? loadAllPlugins();

  // Base schema with core fields
  const schema: Record<string, unknown> = {
    name: 'EXAMPLE-your-repo-name',
    environments: {
      staging: {
        domain: 'EXAMPLE-staging.yourdomain.com',
        host: 'EXAMPLE-192.168.1.100',
      },
      prod: {
        domain: 'EXAMPLE-yourdomain.com',
        host: 'EXAMPLE-54.123.45.67',
      },
    },
  };

  // Merge plugin config schemas
  for (const PluginClass of actualPlugins) {
    if (PluginClass.configSchema) {
      Object.assign(schema, PluginClass.configSchema);
    }
  }

  return yaml.dump(schema, {
    lineWidth: -1, // Don't wrap lines
    noRefs: true,
  });
}

/**
 * Generate factiii.yml file in the target directory
 */
export function generateFactiiiYml(rootDir: string, options: GenerateOptions = {}): boolean {
  const outputPath = path.join(rootDir, 'factiii.yml');

  // Check if file already exists
  if (fs.existsSync(outputPath) && !options.force) {
    console.log('⏭️  factiii.yml already exists (use --force to overwrite)');
    return false;
  }

  // Use provided plugins or load all
  const content = generateFactiiiYmlTemplate(options.plugins ?? null);

  // Write file
  fs.writeFileSync(outputPath, content);

  console.log('✅ Created factiii.yml');
  console.log('\n💡 Next steps:');
  console.log('   1. Replace EXAMPLE- values with your actual values');
  console.log('   2. Run: npx factiii scan');
  console.log('   3. Run: npx factiii fix\n');

  return true;
}

