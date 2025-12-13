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
  
  // First, run normal init to validate local setup
  console.log('🔍 Running init check first...\n');
  await init({ ...options, noRemote: true });
  
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
    console.error('   Set it as: export GITHUB_TOKEN=ghp_your_token_here');
    console.error('   Or pass: npx core init fix --token <token>');
    process.exit(1);
  }
  
  // Get repo info
  const repoInfo = getGitHubRepoInfo();
  if (!repoInfo) {
    console.error('❌ Could not detect GitHub repository');
    console.error('   Make sure you are in a git repository with a GitHub remote');
    process.exit(1);
  }
  
  console.log(`\n🔧 Fixing environment: ${repoInfo.owner}/${repoInfo.repo}\n`);
  
  // Check for .env files
  const stagingPath = path.join(rootDir, '.env.staging');
  const prodPath = path.join(rootDir, '.env.prod');
  
  const stagingExists = fs.existsSync(stagingPath);
  const prodExists = fs.existsSync(prodPath);
  
  if (!stagingExists && !prodExists) {
    console.error('❌ No environment files found');
    console.error('   Create .env.staging and/or .env.prod files');
    process.exit(1);
  }
  
  // Upload STAGING_ENVS if .env.staging exists
  if (stagingExists) {
    console.log('📤 Uploading STAGING_ENVS...');
    const stagingEnv = parseEnvFile(stagingPath);
    if (!stagingEnv || Object.keys(stagingEnv).length === 0) {
      console.log('   ⚠️  .env.staging is empty, skipping');
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
        console.log('   ✅ STAGING_ENVS uploaded successfully');
      } else {
        console.error(`   ❌ Failed to upload STAGING_ENVS: ${result.error}`);
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
    console.log('📤 Uploading PROD_ENVS...');
    const prodEnv = parseEnvFile(prodPath);
    if (!prodEnv || Object.keys(prodEnv).length === 0) {
      console.log('   ⚠️  .env.prod is empty, skipping');
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
        console.log('   ✅ PROD_ENVS uploaded successfully');
      } else {
        console.error(`   ❌ Failed to upload PROD_ENVS: ${result.error}`);
        if (!options.continueOnError) {
          process.exit(1);
        }
      }
    }
  } else {
    console.error('   ❌ .env.prod not found - REQUIRED');
    console.error('   Create .env.prod file with production environment variables');
    if (!options.continueOnError) {
      process.exit(1);
    }
  }
  
  console.log('\n✨ Init fix completed!');
  console.log('   Secrets have been uploaded to GitHub');
  console.log('   Run: npx core init (to verify)\n');
}

module.exports = initFix;

