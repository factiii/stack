/**
 * Deploy Command
 * 
 * Runs scan, aborts if problems found, then deploys.
 * For staging/prod: triggers GitHub Actions workflow and streams logs.
 * For dev: calls plugin deploy methods directly.
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
const { execSync } = require('child_process');
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
 * Load relevant plugin classes (without instantiation)
 */
async function loadPluginClasses(rootDir, config) {
  const { loadRelevantPlugins } = require('../plugins');
  return await loadRelevantPlugins(rootDir, config);
}

/**
 * Get pipeline plugin from loaded plugin classes
 */
function getPipelinePlugin(pluginClasses) {
  return pluginClasses.find(p => p.category === 'pipeline');
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
  else stages = ['dev', 'staging', 'prod']; // Secrets don't deploy
  
  console.log('═'.repeat(60));
  console.log('🚀 FACTIII DEPLOY');
  console.log('═'.repeat(60) + '\n');
  
  // 1. Run scan - ABORT if any critical/warning problems found (ignore info)
  console.log('📋 Stage 1: Running pre-deploy checks...\n');
  const problems = await scan({ 
    rootDir, 
    stages: stages.filter(s => s !== 'secrets'), // Secrets are checked separately
    silent: true 
  });
  
  // Filter out info-level issues (they don't block deployment)
  const blockingProblems = {};
  for (const [stage, stageProblems] of Object.entries(problems)) {
    blockingProblems[stage] = stageProblems.filter(p => p.severity !== 'info');
  }
  
  const totalBlockingProblems = Object.values(blockingProblems).flat().length;
  
  if (totalBlockingProblems > 0) {
    console.log('❌ Pre-deploy checks failed!\n');
    
    // Display blocking problems
    for (const [stage, stageProblems] of Object.entries(blockingProblems)) {
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
  
  // 2. Determine deployment mode using canReach()
  const pluginClasses = await loadPluginClasses(rootDir, config);
  const pipelinePlugin = getPipelinePlugin(pluginClasses);
  
  const remoteStages = stages.filter(s => s === 'staging' || s === 'prod');
  const localStages = stages.filter(s => s === 'dev');
  
  // Deploy remote stages
  if (remoteStages.length > 0) {
    for (const stage of remoteStages) {
      // Check how to reach this stage
      let reach = { reachable: true, via: 'workflow' }; // Default assumption
      
      if (pipelinePlugin && typeof pipelinePlugin.canReach === 'function') {
        reach = pipelinePlugin.canReach(stage, config);
      }
      
      if (!reach.reachable) {
        console.error(`❌ Cannot deploy to ${stage}: ${reach.reason}`);
        process.exit(1);
      }
      
      if (reach.via === 'workflow') {
        // We're on local machine - trigger GitHub Actions workflow
        await deployRemoteStagesViaWorkflow([stage]);
      } else if (reach.via === 'local') {
        // We're ON the server - do the actual deployment
        await deployRemoteStagesOnServer([stage], rootDir, config, options);
      }
    }
  }
  
  // Deploy local stages directly
  if (localStages.length > 0) {
    // Load plugins
    const plugins = await loadPlugins(rootDir, config);
    
    console.log('═'.repeat(60));
    console.log('📋 LOCAL DEPLOYMENT');
    console.log('═'.repeat(60) + '\n');
    
    for (const stage of localStages) {
      console.log(`🚀 Deploying ${stage}...\n`);
      
      // Load env file for this environment
      loadEnvFile(path.join(rootDir, '.env'));
      
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
    
    console.log('═'.repeat(60));
    console.log('✅ LOCAL DEPLOYMENT COMPLETE');
    console.log('═'.repeat(60) + '\n');
  }
}

/**
 * Deploy remote stages via GitHub Actions workflow (from local machine)
 */
async function deployRemoteStagesViaWorkflow(remoteStages) {
  // Check if GitHub CLI is available
  let hasGhCli = false;
  try {
    execSync('which gh', { stdio: 'pipe' });
    execSync('gh auth status', { stdio: 'pipe' });
    hasGhCli = true;
  } catch {
    hasGhCli = false;
  }
  
  if (hasGhCli) {
    // Use workflow monitoring for remote deployments
    const GitHubWorkflowMonitor = require('../utils/github-workflow-monitor');
    
    for (const stage of remoteStages) {
      console.log('═'.repeat(60));
      console.log(`🚀 DEPLOYING ${stage.toUpperCase()}`);
      console.log('═'.repeat(60) + '\n');
      
      try {
        const monitor = new GitHubWorkflowMonitor();
        const result = await monitor.triggerAndWatch('factiii-deploy.yml', stage);
        
        if (!result.success) {
          console.error(`\n❌ ${stage} deployment failed!`);
          process.exit(1);
        }
      } catch (error) {
        console.error(`\n❌ Error deploying ${stage}: ${error.message}`);
        process.exit(1);
      }
      
      console.log('');
    }
  } else {
    console.log('⚠️  GitHub CLI not found - cannot monitor remote deployments');
    console.log('   Install with: brew install gh');
    console.log('   Then run: gh auth login\n');
    console.log('💡 Remote deployments must be triggered manually via GitHub Actions UI\n');
    process.exit(1);
  }
}

/**
 * Deploy remote stages directly on the server (called by workflow)
 */
async function deployRemoteStagesOnServer(remoteStages, rootDir, config, options) {
  // Load plugins
  const plugins = await loadPlugins(rootDir, config);
  
  for (const stage of remoteStages) {
    console.log('═'.repeat(60));
    console.log(`🚀 DEPLOYING ${stage.toUpperCase()}`);
    console.log('═'.repeat(60) + '\n');
    
    // Find server plugin for this environment
    const serverPlugin = plugins.find(p => 
      p.constructor.category === 'server'
    );
    
    if (!serverPlugin) {
      console.error(`❌ No server plugin found for ${stage}`);
      process.exit(1);
    }
    
    try {
      // 1. Ensure server is ready (Node.js, git, repo, dependencies)
      // Skip if running from workflow (workflow already handled setup)
      if (!process.env.GITHUB_ACTIONS) {
        console.log(`📦 Preparing ${stage} server...\n`);
        await serverPlugin.ensureServerReady(config, stage, {
          commitHash: options.commit || process.env.COMMIT_HASH,
          branch: options.branch || process.env.BRANCH || 'main',
          repoUrl: process.env.GITHUB_REPO
        });
        console.log('');
      }
      
      // 2. Load environment file
      const envFile = stage === 'staging' ? '.env.staging' : '.env.prod';
      loadEnvFile(path.join(rootDir, envFile));
      
      // 3. Run deployment
      console.log(`🚀 Deploying ${stage}...\n`);
      const result = await serverPlugin.deploy(config, stage);
      
      if (result.success) {
        console.log(`   ✅ ${result.message || 'Deployment complete'}`);
      } else {
        console.error(`   ❌ ${result.error || 'Deployment failed'}`);
        process.exit(1);
      }
      
      console.log('');
    } catch (error) {
      console.error(`\n❌ Error deploying ${stage}: ${error.message}`);
      process.exit(1);
    }
  }
  
  console.log('═'.repeat(60));
  console.log('✅ DEPLOYMENT COMPLETE');
  console.log('═'.repeat(60) + '\n');
}

module.exports = deploy;
