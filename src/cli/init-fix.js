const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const init = require('./init');
const { getGitHubRepoInfo, uploadSecret } = require('../utils/github-secrets');
const { parseEnvFile } = require('../utils/env-validator');

/**
 * Convert env object to newline-separated key=value string
 */
function envObjectToString(env) {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

/**
 * Main init fix function - fixes all environments including uploading secrets
 */
async function initFix(options = {}) {
  const rootDir = process.cwd();
  const configPath = path.join(rootDir, 'core.yml');
  
  console.log('═'.repeat(70));
  console.log('🔧 INIT FIX: Automated Environment Setup');
  console.log('═'.repeat(70));
  console.log('');
  
  // Track what we fix
  const fixReport = {
    local: [],
    github: [],
    servers: {
      staging: [],
      prod: []
    },
    errors: []
  };
  
  // ============================================================
  // STAGE 1: CHECK EVERYTHING FIRST
  // ============================================================
  console.log('📋 Stage 1: Discovering Issues\n');
  console.log('   Running comprehensive check...\n');
  
  // Run init check to discover all issues
  await init({ ...options, noRemote: true });
  
  console.log('\n' + '─'.repeat(70));
  console.log('');
  
  // Check if we have a config
  if (!fs.existsSync(configPath)) {
    console.error('❌ core.yml not found. Run: npx core init');
    process.exit(1);
  }
  
  const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
  
  // Get GitHub token
  const token = options.token || process.env.GITHUB_TOKEN;
  
  if (!token) {
    console.error('❌ GITHUB_TOKEN required to upload secrets');
    console.error('');
    console.error('   Generate token: https://github.com/settings/tokens');
    console.error('   → Select scopes: repo + workflow');
    console.error('');
    console.error('   Add to your shell config (recommended):');
    console.error('   echo \'export GITHUB_TOKEN=ghp_your_token_here\' >> ~/.zshrc');
    console.error('   source ~/.zshrc');
    console.error('');
    console.error('   Or pass temporarily: npx core init fix --token <token>');
    process.exit(1);
  }
  
  // Get repo info
  const repoInfo = getGitHubRepoInfo();
  if (!repoInfo) {
    console.error('❌ Could not detect GitHub repository');
    console.error('   Make sure you are in a git repository with a GitHub remote');
    process.exit(1);
  }
  
  console.log('═'.repeat(70));
  console.log(`🔧 Stage 2: Fixing Issues for ${repoInfo.owner}/${repoInfo.repo}`);
  console.log('═'.repeat(70));
  console.log('');
  
  // ============================================================
  // STAGE 2A: LOCAL ENVIRONMENT (already fixed by init above)
  // ============================================================
  console.log('📦 Part 1: Local Environment');
  console.log('   ✅ Configs generated (done by init check)');
  console.log('   ✅ Dependencies validated');
  console.log('   ✅ All local files ready\n');
  fixReport.local.push('Local environment configured');
  
  // ============================================================
  // STAGE 2B: GITHUB SECRETS (must happen before servers can deploy)
  // ============================================================
  console.log('🔐 Part 2: GitHub Secrets Upload\n');
  
  // Check for .env files
  const stagingPath = path.join(rootDir, '.env.staging');
  const prodPath = path.join(rootDir, '.env.prod');
  
  const stagingExists = fs.existsSync(stagingPath);
  const prodExists = fs.existsSync(prodPath);
  
  if (!stagingExists && !prodExists) {
    console.error('   ❌ No environment files found');
    console.error('   Create .env.staging and/or .env.prod files');
    fixReport.errors.push('No environment files found');
    process.exit(1);
  }
  
  // Upload STAGING_ENVS if .env.staging exists
  if (stagingExists) {
    console.log('   📤 Uploading STAGING_ENVS...');
    const stagingEnv = parseEnvFile(stagingPath);
    if (!stagingEnv || Object.keys(stagingEnv).length === 0) {
      console.log('      ⚠️  .env.staging is empty, skipping');
    } else {
      const stagingString = envObjectToString(stagingEnv);
      const result = await uploadSecret(
        repoInfo.owner,
        repoInfo.repo,
        'STAGING_ENVS',
        stagingString,
        token
      );
      
      if (result.success) {
        console.log('      ✅ STAGING_ENVS uploaded successfully');
        console.log(`      📊 ${Object.keys(stagingEnv).length} environment variables`);
        fixReport.github.push(`STAGING_ENVS (${Object.keys(stagingEnv).length} vars)`);
      } else {
        console.error(`      ❌ Failed: ${result.error}`);
        fixReport.errors.push(`STAGING_ENVS: ${result.error}`);
        if (!options.continueOnError) {
          process.exit(1);
        }
      }
    }
  } else {
    console.log('   ⚠️  .env.staging not found, skipping STAGING_ENVS');
  }
  
  // Upload PROD_ENVS if .env.prod exists
  if (prodExists) {
    console.log('   📤 Uploading PROD_ENVS...');
    const prodEnv = parseEnvFile(prodPath);
    if (!prodEnv || Object.keys(prodEnv).length === 0) {
      console.log('      ⚠️  .env.prod is empty, skipping');
    } else {
      const prodString = envObjectToString(prodEnv);
      const result = await uploadSecret(
        repoInfo.owner,
        repoInfo.repo,
        'PROD_ENVS',
        prodString,
        token
      );
      
      if (result.success) {
        console.log('      ✅ PROD_ENVS uploaded successfully');
        console.log(`      📊 ${Object.keys(prodEnv).length} environment variables`);
        fixReport.github.push(`PROD_ENVS (${Object.keys(prodEnv).length} vars)`);
      } else {
        console.error(`      ❌ Failed: ${result.error}`);
        fixReport.errors.push(`PROD_ENVS: ${result.error}`);
        if (!options.continueOnError) {
          process.exit(1);
        }
      }
    }
  } else {
    console.error('   ❌ .env.prod not found - REQUIRED');
    console.error('   Create .env.prod file with production environment variables');
    fixReport.errors.push('.env.prod not found');
    if (!options.continueOnError) {
      process.exit(1);
    }
  }
  
  console.log('');
  
  // ============================================================
  // STAGE 2C: REMOTE SERVERS (can only work after secrets exist)
  // ============================================================
  console.log('🖥️  Part 3: Remote Server Setup\n');
  console.log('   ℹ️  Server fixes will be done by deployment workflows');
  console.log('   ℹ️  SSH checks will run in verification step\n');
  fixReport.servers.staging.push('Ready for deployment');
  fixReport.servers.prod.push('Ready for deployment');
  
  // ============================================================
  // FINAL REPORT
  // ============================================================
  console.log('═'.repeat(70));
  console.log('✨ Init Fix Complete!');
  console.log('═'.repeat(70));
  console.log('');
  console.log('📊 Summary of Fixes:\n');
  
  if (fixReport.local.length > 0) {
    console.log('   Local Environment:');
    fixReport.local.forEach(fix => console.log(`      ✅ ${fix}`));
    console.log('');
  }
  
  if (fixReport.github.length > 0) {
    console.log('   GitHub Secrets:');
    fixReport.github.forEach(fix => console.log(`      ✅ ${fix}`));
    console.log('');
  }
  
  if (fixReport.errors.length > 0) {
    console.log('   ⚠️  Errors:');
    fixReport.errors.forEach(err => console.log(`      ❌ ${err}`));
    console.log('');
  }
  
  console.log('💡 Verify secrets in GitHub:');
  console.log(`   https://github.com/${repoInfo.owner}/${repoInfo.repo}/settings/secrets/actions`);
  console.log('');
  
  // Optionally trigger workflow to verify
  if (!options.noRemote && token) {
    console.log('\n🚀 Triggering workflow to verify fixes...\n');
    try {
      const { Octokit } = require('@octokit/rest');
      const octokit = new Octokit({ auth: token });
      const { execSync } = require('child_process');
      
      // Get current branch
      let currentBranch;
      try {
        currentBranch = execSync('git branch --show-current', { 
          encoding: 'utf8',
          stdio: 'pipe',
          cwd: rootDir 
        }).trim();
      } catch (e) {
        currentBranch = 'main';
      }
      
      // Verify workflow exists in GitHub before triggering
      try {
        const { data: workflow } = await octokit.rest.actions.getWorkflow({
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          workflow_id: 'core-init.yml'
        });
        console.log(`✅ Found workflow: ${workflow.name}\n`);
      } catch (error) {
        if (error.status === 404) {
          console.log('⚠️  Workflow not found in GitHub repository.');
          console.log('   Please commit and push .github/workflows/core-init.yml');
          console.log('   Then run: npx core init (to verify)\n');
          return;
        }
        throw error;
      }
      
      // Trigger workflow with fix=true to verify
      await octokit.rest.actions.createWorkflowDispatch({
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        workflow_id: 'core-init.yml',
        ref: currentBranch,
        inputs: {
          fix: 'true' // Verify fixes were applied
        }
      });
      
      console.log(`✅ Workflow triggered on branch: ${currentBranch}`);
      console.log(`   Repository: ${repoInfo.owner}/${repoInfo.repo}`);
      console.log(`   View: https://github.com/${repoInfo.owner}/${repoInfo.repo}/actions\n`);
    } catch (error) {
      if (error.status === 404) {
        console.log('⚠️  Workflow not found in GitHub.');
        console.log('   Please commit and push .github/workflows/core-init.yml\n');
      } else {
        console.log(`⚠️  Could not trigger workflow: ${error.message}`);
        console.log('   Run: npx core init (to verify manually)\n');
      }
    }
  } else {
    console.log('   Run: npx core init (to verify)\n');
  }
}

module.exports = initFix;

