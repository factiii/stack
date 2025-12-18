const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Load all plugins
 */
function loadAllPlugins() {
  const plugins = [];
  
  // Load pipeline plugins
  try {
    const FactiiiPipeline = require('../plugins/pipelines/factiii');
    plugins.push(FactiiiPipeline);
  } catch (e) {
    // Plugin not available
  }
  
  // Load server plugins
  try {
    const MacMiniPlugin = require('../plugins/servers/mac-mini');
    plugins.push(MacMiniPlugin);
  } catch (e) {
    // Plugin not available
  }
  
  try {
    const AWSPlugin = require('../plugins/servers/aws');
    plugins.push(AWSPlugin);
  } catch (e) {
    // Plugin not available
  }
  
  // Load framework plugins
  try {
    const PrismaTrpcPlugin = require('../plugins/frameworks/prisma-trpc');
    plugins.push(PrismaTrpcPlugin);
  } catch (e) {
    // Plugin not available
  }
  
  return plugins;
}

/**
 * Generate factiii.yml template from plugin schemas
 * @param {Array} plugins - Optional array of plugin classes to use
 */
function generateFactiiiYmlTemplate(plugins = null) {
  if (!plugins) {
    plugins = loadAllPlugins();
  }
  
  // Base schema with core fields
  const schema = {
    name: 'EXAMPLE-your-repo-name',
    environments: {
      staging: {
        domain: 'EXAMPLE-staging.yourdomain.com',
        host: 'EXAMPLE-192.168.1.100'
      },
      prod: {
        domain: 'EXAMPLE-yourdomain.com',
        host: 'EXAMPLE-54.123.45.67'
      }
    }
  };
  
  // Merge plugin config schemas
  for (const PluginClass of plugins) {
    if (PluginClass.configSchema) {
      Object.assign(schema, PluginClass.configSchema);
    }
  }
  
  return yaml.dump(schema, {
    lineWidth: -1,  // Don't wrap lines
    noRefs: true
  });
}

/**
 * Generate factiii.yml file in the target directory
 */
function generateFactiiiYml(rootDir, options = {}) {
  const outputPath = path.join(rootDir, 'factiii.yml');
  
  // Check if file already exists
  if (fs.existsSync(outputPath) && !options.force) {
    console.log('⏭️  factiii.yml already exists (use --force to overwrite)');
    return false;
  }
  
  // Use provided plugins or load all
  const content = generateFactiiiYmlTemplate(options.plugins);
  
  // Write file
  fs.writeFileSync(outputPath, content);
  
  console.log('✅ Created factiii.yml');
  console.log('\n💡 Next steps:');
  console.log('   1. Replace EXAMPLE- values with your actual values');
  console.log('   2. Run: npx factiii scan');
  console.log('   3. Run: npx factiii fix\n');
  
  return true;
}

module.exports = { generateFactiiiYml, generateFactiiiYmlTemplate };
