/**
 * Init Command
 * 
 * Scans project, detects relevant plugins, generates config files.
 * 
 * Usage:
 *   npx factiii init           # Initialize new project
 *   npx factiii init --force   # Regenerate configs
 */
const fs = require('fs');
const path = require('path');

/**
 * Main init function
 */
async function init(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  
  console.log('═'.repeat(60));
  console.log('🚀 FACTIII INIT');
  console.log('═'.repeat(60) + '\n');
  
  // Check if configs already exist
  const ymlExists = fs.existsSync(path.join(rootDir, 'factiii.yml'));
  const autoExists = fs.existsSync(path.join(rootDir, 'factiiiAuto.yml'));
  
  if ((ymlExists || autoExists) && !options.force) {
    console.log('⚠️  Configuration files already exist.');
    console.log('   Use --force to regenerate them.\n');
    console.log('   Existing files:');
    if (ymlExists) console.log('   - factiii.yml');
    if (autoExists) console.log('   - factiiiAuto.yml');
    console.log('');
    return;
  }
  
  console.log('🔍 Scanning project structure...\n');
  
  // 1. Detect which plugins are relevant
  const { loadRelevantPlugins } = require('../plugins');
  const plugins = await loadRelevantPlugins(rootDir, {});
  
  if (plugins.length === 0) {
    console.log('⚠️  No plugins detected. Loading defaults...\n');
  } else {
    console.log('📦 Detected plugins:');
    for (const PluginClass of plugins) {
      console.log(`   ✅ ${PluginClass.name} (${PluginClass.id})`);
    }
    console.log('');
  }
  
  // 2. Generate factiii.yml with only relevant sections
  console.log('📝 Generating factiii.yml...');
  const { generateFactiiiYml } = require('../generators/generate-factiii-yml');
  await generateFactiiiYml(rootDir, { plugins, force: options.force });
  
  // 3. Generate factiiiAuto.yml with detected values
  console.log('📝 Generating factiiiAuto.yml...');
  const { generateFactiiiAuto } = require('../generators/generate-factiii-auto');
  await generateFactiiiAuto(rootDir, { plugins, force: options.force });
  
  // 4. Generate workflows
  console.log('📝 Generating GitHub workflows...');
  const generateWorkflows = require('./generate-workflows');
  await generateWorkflows({ output: '.github/workflows' });
  
  console.log('\n' + '═'.repeat(60));
  console.log('✅ INITIALIZATION COMPLETE!');
  console.log('═'.repeat(60) + '\n');
  
  console.log('📋 Next steps:\n');
  console.log('  1. Edit factiii.yml - replace EXAMPLE- values with your actual values');
  console.log('  2. Run: npx factiii scan       # Check for issues');
  console.log('  3. Run: npx factiii fix        # Auto-fix issues where possible');
  console.log('  4. Run: npx factiii deploy --staging  # Deploy to staging\n');
}

module.exports = init;
