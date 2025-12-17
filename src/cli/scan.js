/**
 * Scan Command
 * 
 * Runs scan side of all plugin fixes.
 * Returns problems found (which are the fixes that need to run).
 * 
 * Usage:
 *   npx factiii scan           # Scan all stages
 *   npx factiii scan --dev     # Scan dev only
 *   npx factiii scan --staging # Scan staging only
 *   npx factiii scan --prod    # Scan prod only
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Load all plugins and collect their fixes
 */
function loadPlugins(rootDir) {
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
    console.error(`⚠️  Error parsing factiii.yml: ${e.message}`);
    return {};
  }
}

/**
 * Generate env var fixes from plugin requiredEnvVars
 */
function generateEnvVarFixes(plugin, rootDir) {
  const fixes = [];
  
  for (const varName of plugin.requiredEnvVars || []) {
    // Check .env.example has the var
    fixes.push({
      id: `missing-env-example-${varName.toLowerCase()}`,
      stage: 'dev',
      severity: 'critical',
      description: `${varName} not found in .env.example`,
      plugin: plugin.id,
      scan: async () => {
        const envPath = path.join(rootDir, '.env.example');
        if (!fs.existsSync(envPath)) return true;
        const content = fs.readFileSync(envPath, 'utf8');
        return !content.includes(`${varName}=`);
      },
      fix: null,
      manualFix: `Add ${varName}=your_value to .env.example`
    });
    
    // Check .env.staging has the var
    fixes.push({
      id: `missing-env-staging-${varName.toLowerCase()}`,
      stage: 'staging',
      severity: 'critical',
      description: `${varName} not found in .env.staging`,
      plugin: plugin.id,
      scan: async () => {
        const envPath = path.join(rootDir, '.env.staging');
        if (!fs.existsSync(envPath)) return true;
        const content = fs.readFileSync(envPath, 'utf8');
        return !content.includes(`${varName}=`);
      },
      fix: null,
      manualFix: `Add ${varName}=staging_value to .env.staging`
    });
    
    // Check .env.prod has the var
    fixes.push({
      id: `missing-env-prod-${varName.toLowerCase()}`,
      stage: 'prod',
      severity: 'critical',
      description: `${varName} not found in .env.prod`,
      plugin: plugin.id,
      scan: async () => {
        const envPath = path.join(rootDir, '.env.prod');
        if (!fs.existsSync(envPath)) return true;
        const content = fs.readFileSync(envPath, 'utf8');
        return !content.includes(`${varName}=`);
      },
      fix: null,
      manualFix: `Add ${varName}=production_value to .env.prod`
    });
  }
  
  return fixes;
}

/**
 * Display problems grouped by stage
 */
function displayProblems(problems, options = {}) {
  if (options.silent) return;
  
  const stages = ['dev', 'secrets', 'staging', 'prod'];
  let totalProblems = 0;
  
  console.log('\n' + '═'.repeat(60));
  console.log('📋 SCAN RESULTS');
  console.log('═'.repeat(60) + '\n');
  
  for (const stage of stages) {
    const stageProblems = problems[stage] || [];
    
    if (stageProblems.length === 0) {
      console.log(`✅ ${stage.toUpperCase()}: No issues found`);
    } else {
      console.log(`❌ ${stage.toUpperCase()}: ${stageProblems.length} issue(s) found`);
      for (const problem of stageProblems) {
        const icon = problem.fix ? '🔧' : '📝';
        const autoFix = problem.fix ? '(auto-fixable)' : '(manual fix required)';
        console.log(`   ${icon} ${problem.description} ${autoFix}`);
      }
      totalProblems += stageProblems.length;
    }
    console.log('');
  }
  
  console.log('─'.repeat(60));
  if (totalProblems === 0) {
    console.log('✅ All checks passed!\n');
  } else {
    console.log(`❌ Found ${totalProblems} issue(s). Run: npx factiii fix\n`);
  }
}

/**
 * Main scan function
 */
async function scan(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const config = loadConfig(rootDir);
  
  // Determine which stages to scan
  let stages = ['dev', 'secrets', 'staging', 'prod'];
  if (options.dev) stages = ['dev'];
  else if (options.secrets) stages = ['secrets'];
  else if (options.staging) stages = ['staging'];
  else if (options.prod) stages = ['prod'];
  else if (options.stages) stages = options.stages;
  
  // Load all plugins
  const plugins = loadPlugins(rootDir);
  
  // Collect all fixes from all plugins
  const allFixes = [];
  for (const plugin of plugins) {
    // Add plugin fixes
    for (const fix of plugin.fixes || []) {
      allFixes.push({ ...fix, plugin: plugin.id });
    }
    
    // Add auto-generated env var fixes
    const envFixes = generateEnvVarFixes(plugin, rootDir);
    allFixes.push(...envFixes);
  }
  
  // Run scan() for each fix, collect problems found
  const problems = {
    dev: [],
    secrets: [],
    staging: [],
    prod: []
  };
  
  if (!options.silent) {
    console.log('🔍 Scanning...\n');
  }
  
  for (const fix of allFixes) {
    // Skip if stage not in requested stages
    if (!stages.includes(fix.stage)) continue;
    
    try {
      // Run the scan function
      const hasProblem = await fix.scan(config, rootDir);
      
      if (hasProblem) {
        problems[fix.stage].push(fix);
      }
    } catch (e) {
      // Scan failed - treat as problem
      if (!options.silent) {
        console.log(`   ⚠️  Error scanning ${fix.id}: ${e.message}`);
      }
    }
  }
  
  // Display problems grouped by stage
  displayProblems(problems, options);
  
  // Return the fixes needed (problems found)
  return problems;
}

module.exports = scan;
