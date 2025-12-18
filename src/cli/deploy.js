/**
 * Deploy Command
 * 
 * Runs scan, aborts if problems found, then deploys.
 * Calls each plugin's deploy() method for the requested environment.
 * 
 * Usage:
 *   npx factiii deploy           # Deploy all (runs on server)
 *   npx factiii deploy --dev     # Deploy dev (local containers)
 *   npx factiii deploy --staging # Deploy staging
 *   npx factiii deploy --prod    # Deploy production
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const scan = require('./scan');

/**
 * Load relevant plugins based on config
 */
async function loadPlugins(rootDir, config) {
  // If no config exists, tell user to run init
  if (!config || Object.keys(config).length === 0) {
    console.error('\n❌ No factiii.yml found.');
    console.error('   Run: npx factiii init\n');
    process.exit(1);
  }
  
  const { loadRelevantPlugins } = require('../plugins');
  const PluginClasses = await loadRelevantPlugins(rootDir, config);
  
  // Instantiate plugins
  return PluginClasses.map(PluginClass => new PluginClass(config));
}

/**
 * Load config from factiii.yml
 */
function loadConfig(rootDir) {
  const configPath = path.join(rootDir, 'factiii.yml');
  
  if (!fs.existsSync(configPath)) {
    return {};
  }
  
  try {
    return yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
  } catch (e) {
    return {};
  }
}

/**
 * Load environment file
 */
function loadEnvFile(envFile) {
  if (!fs.existsSync(envFile)) {
    return;
  }
  
  const content = fs.readFileSync(envFile, 'utf8');
  const lines = content.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (match) {
      const [, key, value] = match;
      process.env[key] = value.replace(/^["']|["']$/g, '');
    }
  }
}

/**
 * Main deploy function
 */
async function deploy(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const config = loadConfig(rootDir);
  
  // Determine which stages to deploy
  let stages = [];
  if (options.dev) stages = ['dev'];
  else if (options.staging) stages = ['staging'];
  else if (options.prod) stages = ['prod'];
  else if (options.environment) stages = [options.environment];
  else stages = ['dev', 'secrets', 'staging', 'prod'];
  
  console.log('═'.repeat(60));
  console.log('🚀 FACTIII DEPLOY');
  console.log('═'.repeat(60) + '\n');
  
  // 1. Run scan - ABORT if any problems found
  console.log('📋 Stage 1: Running pre-deploy checks...\n');
  const problems = await scan({ 
    rootDir, 
    stages: stages.filter(s => s !== 'secrets'), // Secrets are checked separately
    silent: true 
  });
  
  const totalProblems = Object.values(problems).flat().length;
  
  if (totalProblems > 0) {
    console.log('❌ Pre-deploy checks failed!\n');
    
    // Display problems
    for (const [stage, stageProblems] of Object.entries(problems)) {
      if (stageProblems.length > 0) {
        console.log(`   ${stage.toUpperCase()}:`);
        for (const problem of stageProblems) {
          console.log(`   - ${problem.description}`);
        }
      }
    }
    
    console.log('\n💡 Fix issues first: npx factiii fix\n');
    process.exit(1);
  }
  
  console.log('✅ All pre-deploy checks passed!\n');
  
  // 2. Load plugins
  const plugins = await loadPlugins(rootDir, config);
  
  // 3. Deploy each environment requested
  console.log('═'.repeat(60));
  console.log('📋 Stage 2: Deploying...');
  console.log('═'.repeat(60) + '\n');
  
  for (const stage of stages) {
    if (stage === 'secrets') continue; // Secrets don't deploy
    
    console.log(`🚀 Deploying ${stage}...\n`);
    
    // Load env file for this environment
    if (stage === 'staging') {
      loadEnvFile(path.join(rootDir, '.env.staging'));
    } else if (stage === 'prod') {
      loadEnvFile(path.join(rootDir, '.env.prod'));
    } else if (stage === 'dev') {
      loadEnvFile(path.join(rootDir, '.env'));
    }
    
    // Call each plugin's deploy method
    for (const plugin of plugins) {
      if (plugin.deploy) {
        try {
          const result = await plugin.deploy(config, stage);
          if (result.message) {
            console.log(`   ✅ ${plugin.constructor.name}: ${result.message}`);
          }
        } catch (e) {
          console.log(`   ⚠️  ${plugin.constructor.name}: ${e.message}`);
        }
      }
    }
    
    console.log('');
  }
  
  // 4. Summary
  console.log('═'.repeat(60));
  console.log('✅ DEPLOY COMPLETE');
  console.log('═'.repeat(60) + '\n');
  
  for (const stage of stages.filter(s => s !== 'secrets')) {
    console.log(`   ✅ ${stage}: Deployed`);
  }
  console.log('');
}

module.exports = deploy;
