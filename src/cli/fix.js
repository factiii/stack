/**
 * Fix Command
 * 
 * Runs scan, then applies fixes in order.
 * Can reorder fixes based on dependencies.
 * 
 * Usage:
 *   npx factiii fix           # Fix all stages
 *   npx factiii fix --dev     # Fix dev only
 *   npx factiii fix --staging # Fix staging only
 *   npx factiii fix --prod    # Fix prod only
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const scan = require('./scan');
const { generateFactiiiYml } = require('../generators/generate-factiii-yml');
const { generateFactiiiAuto } = require('../generators/generate-factiii-auto');

/**
 * Load relevant plugins based on config
 */
async function loadPlugins(rootDir, config) {
  const { loadRelevantPlugins } = require('../plugins');
  return await loadRelevantPlugins(rootDir, config);
}

/**
 * Get pipeline plugin from loaded plugins
 */
function getPipelinePlugin(plugins) {
  return plugins.find(p => p.category === 'pipeline');
}

/**
 * Reorder fixes based on dependencies (stage order, then severity)
 */
function reorderFixes(fixes) {
  const stageOrder = { dev: 0, secrets: 1, staging: 2, prod: 3 };
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  
  return fixes.sort((a, b) => {
    // First sort by stage
    const stageDiff = stageOrder[a.stage] - stageOrder[b.stage];
    if (stageDiff !== 0) return stageDiff;
    
    // Then by severity
    return (severityOrder[a.severity] || 2) - (severityOrder[b.severity] || 2);
  });
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
 * Main fix function
 */
async function fix(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  
  console.log('═'.repeat(60));
  console.log('🔧 FACTIII FIX');
  console.log('═'.repeat(60) + '\n');
  
  // 0. Check if config exists, if not tell user to run init
  if (!fs.existsSync(path.join(rootDir, 'factiii.yml'))) {
    console.log('❌ No factiii.yml found.');
    console.log('   Run: npx factiii init\n');
    process.exit(1);
  }
  
  const config = loadConfig(rootDir);
  
  // Load plugins to get pipeline's canReach method
  const plugins = await loadPlugins(rootDir, config);
  const pipelinePlugin = getPipelinePlugin(plugins);
  
  // Determine which stages to fix based on canReach()
  let stages;
  if (options.dev) stages = ['dev'];
  else if (options.secrets) stages = ['secrets'];
  else if (options.staging) stages = ['staging'];
  else if (options.prod) stages = ['prod'];
  else if (options.stages) stages = options.stages;
  else {
    // Default: only fix stages that are reachable directly (not via workflow)
    stages = [];
    const allStages = ['dev', 'secrets', 'staging', 'prod'];
    
    for (const stage of allStages) {
      if (pipelinePlugin && typeof pipelinePlugin.canReach === 'function') {
        const reach = pipelinePlugin.canReach(stage, config);
        // Only include stages reachable directly (not via workflow)
        if (reach.reachable && reach.via !== 'workflow') {
          stages.push(stage);
        }
      } else {
        // No pipeline plugin - assume all reachable
        stages.push(stage);
      }
    }
  }
  
  // 1. Run scan to get all problems (fixes needed)
  console.log('📋 Stage 1: Discovering issues...\n');
  const problems = await scan({ 
    rootDir, 
    stages, 
    silent: true 
  });
  
  // 2. Flatten and reorder fixes
  const fixesToRun = reorderFixes([
    ...problems.dev,
    ...problems.secrets,
    ...problems.staging,
    ...problems.prod
  ]);
  
  if (fixesToRun.length === 0) {
    console.log('✅ No issues found! Everything is configured correctly.\n');
    return { fixed: 0, manual: 0, failed: 0 };
  }
  
  console.log(`Found ${fixesToRun.length} issue(s) to fix:\n`);
  
  // Show summary
  const autoFixable = fixesToRun.filter(f => f.fix).length;
  const manualOnly = fixesToRun.filter(f => !f.fix).length;
  console.log(`   🔧 Auto-fixable: ${autoFixable}`);
  console.log(`   📝 Manual required: ${manualOnly}`);
  console.log('');
  
  // 3. Run each fix
  console.log('═'.repeat(60));
  console.log('📋 Stage 2: Applying fixes...');
  console.log('═'.repeat(60) + '\n');
  
  const results = {
    fixed: 0,
    manual: 0,
    failed: 0
  };
  
  for (const fix of fixesToRun) {
    const stageLabel = fix.stage.toUpperCase().padEnd(8);
    
    if (fix.fix) {
      console.log(`🔧 [${stageLabel}] ${fix.description}`);
      
      try {
        const success = await fix.fix(config, rootDir);
        
        if (success) {
          console.log('   ✅ Fixed\n');
          results.fixed++;
        } else {
          console.log('   ⚠️  Auto-fix incomplete, manual action may be needed');
          console.log(`   💡 ${fix.manualFix}\n`);
          results.manual++;
        }
      } catch (e) {
        console.log(`   ❌ Failed: ${e.message}`);
        console.log(`   💡 ${fix.manualFix}\n`);
        results.failed++;
      }
    } else {
      console.log(`📝 [${stageLabel}] ${fix.description}`);
      console.log(`   💡 ${fix.manualFix}\n`);
      results.manual++;
    }
  }
  
  // 4. Summary
  console.log('═'.repeat(60));
  console.log('📊 FIX SUMMARY');
  console.log('═'.repeat(60) + '\n');
  
  console.log(`   ✅ Fixed automatically: ${results.fixed}`);
  console.log(`   📝 Requires manual action: ${results.manual}`);
  console.log(`   ❌ Failed: ${results.failed}`);
  console.log('');
  
  if (results.manual > 0 || results.failed > 0) {
    console.log('💡 After manual fixes, run: npx factiii scan\n');
  } else {
    console.log('✅ All issues fixed!\n');
    console.log('   Next: npx factiii deploy\n');
  }
  
  return results;
}

module.exports = fix;
