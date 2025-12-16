const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { GitHubSecretsStore } = require('../plugins/secrets/github');
const { getPlugin } = require('../plugins');
const { promptForSecret, confirm, multiSelect } = require('../utils/secret-prompts');
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
 * Get required secrets based on environments in config
 */
function getRequiredSecrets(config) {
  const required = new Set([
    'STAGING_ENVS',
    'PROD_ENVS',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_REGION'
  ]);
  
  // Add environment-specific secrets
  if (config.environments) {
    for (const [envName, envConfig] of Object.entries(config.environments)) {
      const prefix = envName.toUpperCase();
      required.add(`${prefix}_SSH`);
      required.add(`${prefix}_HOST`);
      required.add(`${prefix}_USER`);
    }
  } else {
    // Default staging + production
    required.add('STAGING_SSH');
    required.add('STAGING_HOST');
    required.add('STAGING_USER');
    required.add('PROD_SSH');
    required.add('PROD_HOST');
    required.add('PROD_USER');
  }
  
  return Array.from(required);
}

/**
 * Main secrets management command
 * @param {string[]} secretNames - Optional list of specific secrets to update
 * @param {object} options - Command options
 */
async function secrets(secretNames = [], options = {}) {
  const rootDir = process.cwd();
  const configPath = path.join(rootDir, 'core.yml');
  
  console.log('🔐 GitHub Secrets Management\n');
  console.log('═'.repeat(60));
  console.log('');
  
  // Check for core.yml
  if (!fs.existsSync(configPath)) {
    console.error('❌ core.yml not found');
    console.error('   Run: npx core init');
    process.exit(1);
  }
  
  // Load config
  let config;
  try {
    config = yaml.load(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.error('❌ Failed to parse core.yml:', error.message);
    process.exit(1);
  }
  
  // Get GitHub token
  const token = options.token || process.env.GITHUB_TOKEN;
  
  if (!token) {
    console.error('❌ GITHUB_TOKEN required');
    console.error('');
    console.error('   Generate token: https://github.com/settings/tokens');
    console.error('   → Select scopes: repo + workflow');
    console.error('');
    console.error('   Add to your shell config:');
    console.error('   echo \'export GITHUB_TOKEN=ghp_your_token_here\' >> ~/.zshrc');
    console.error('   source ~/.zshrc');
    console.error('');
    console.error('   Or pass temporarily: --token <token>');
    process.exit(1);
  }
  
  // Get repo info
  const repoInfo = GitHubSecretsStore.getRepoInfo();
  
  if (!repoInfo) {
    console.error('❌ Could not detect GitHub repository');
    console.error('   Make sure you are in a git repository with a GitHub remote');
    process.exit(1);
  }
  
  console.log(`📦 Repository: ${repoInfo.owner}/${repoInfo.repo}\n`);
  
  // Create secret store
  const secretStore = new GitHubSecretsStore({
    token,
    owner: repoInfo.owner,
    repo: repoInfo.repo
  });
  
  // Get required secrets
  const required = getRequiredSecrets(config);
  
  // Check current state via API
  console.log('🔍 Checking current secrets in GitHub...\n');
  const check = await secretStore.checkSecrets(required);
  
  if (check.error) {
    console.error(`❌ ${check.error}`);
    process.exit(1);
  }
  
  // Case 1: Specific secrets provided via command line
  if (secretNames.length > 0) {
    console.log(`📝 Updating ${secretNames.length} secret(s)...\n`);
    
    for (const name of secretNames) {
      // Validate secret name
      if (!required.includes(name)) {
        console.error(`❌ Unknown secret: ${name}`);
        console.error(`   Valid secrets: ${required.join(', ')}`);
        process.exit(1);
      }
      
      // Handle env file secrets specially
      if (name === 'STAGING_ENVS' || name === 'PROD_ENVS') {
        await handleEnvSecret(name, secretStore, rootDir);
      } else {
        // Infrastructure secret - prompt or use --value
        let value;
        
        if (options.value) {
          value = options.value;
          console.log(`✅ Using provided value for ${name}`);
        } else {
          value = await promptForSecret(name, config);
        }
        
        console.log(`📤 Uploading ${name}...`);
        const result = await secretStore.uploadSecret(name, value);
        
        if (result.success) {
          console.log(`✅ ${name} uploaded successfully\n`);
        } else {
          console.error(`❌ Failed to upload ${name}: ${result.error}`);
          process.exit(1);
        }
      }
    }
  }
  
  // Case 2: Interactive mode - show status and let user select
  else {
    console.log('📋 Current Secrets Status:\n');
    
    for (const secret of required) {
      const exists = check.present.includes(secret);
      const status = exists ? '✅' : '❌';
      console.log(`   ${status} ${secret}`);
    }
    
    console.log('');
    
    // Ask which secrets to update
    const choices = required.map(s => ({
      name: s,
      checked: check.missing.includes(s)
    }));
    
    const toUpdate = await multiSelect(
      '? Select secrets to update:',
      choices
    );
    
    if (toUpdate.length === 0) {
      console.log('\n✅ No secrets selected. Exiting.\n');
      return;
    }
    
    console.log(`\n📝 Updating ${toUpdate.length} secret(s)...\n`);
    
    // Prompt and upload each selected secret
    for (const name of toUpdate) {
      // Handle env file secrets specially
      if (name === 'STAGING_ENVS' || name === 'PROD_ENVS') {
        await handleEnvSecret(name, secretStore, rootDir);
      } else {
        // Infrastructure secret - prompt for value
        const value = await promptForSecret(name, config);
        
        console.log(`📤 Uploading ${name}...`);
        const result = await secretStore.uploadSecret(name, value);
        
        if (result.success) {
          console.log(`✅ ${name} uploaded successfully\n`);
        } else {
          console.error(`❌ Failed to upload ${name}: ${result.error}`);
          process.exit(1);
        }
      }
    }
  }
  
  // Success summary
  console.log('═'.repeat(60));
  console.log('✨ Secrets updated successfully!\n');
  
  // Ask about deployment (unless --no-deploy flag)
  if (options.deploy !== false) {
    const shouldDeploy = await confirm('\n🚀 Deploy now?', true);
    
    if (shouldDeploy) {
      console.log('\n📦 Running deployment...\n');
      
      try {
        const deploy = require('./deploy');
        await deploy({ token });
      } catch (error) {
        console.error(`❌ Deployment failed: ${error.message}`);
        process.exit(1);
      }
    } else {
      console.log('\n💡 Run deployment later with: npx core deploy\n');
    }
  }
}

/**
 * Handle env file secrets (STAGING_ENVS, PROD_ENVS)
 * These are read from .env.staging and .env.prod files
 */
async function handleEnvSecret(secretName, secretStore, rootDir) {
  const envType = secretName === 'STAGING_ENVS' ? 'staging' : 'prod';
  const envFile = path.join(rootDir, `.env.${envType}`);
  
  console.log(`\n📄 Processing ${secretName}...`);
  console.log(`   Reading from: .env.${envType}`);
  
  // Check if file exists
  if (!fs.existsSync(envFile)) {
    console.error(`\n❌ .env.${envType} not found`);
    console.error(`   ${secretName} must be read from .env.${envType} file`);
    console.error(`   Create the file with your ${envType} environment variables\n`);
    process.exit(1);
  }
  
  // Parse env file
  const env = parseEnvFile(envFile);
  
  if (!env || Object.keys(env).length === 0) {
    console.error(`\n❌ .env.${envType} is empty`);
    console.error(`   Add environment variables to the file\n`);
    process.exit(1);
  }
  
  console.log(`   Found ${Object.keys(env).length} environment variables`);
  
  // Convert to string format
  const envString = envObjectToString(env);
  
  // Upload
  console.log(`   📤 Uploading to GitHub...`);
  const result = await secretStore.uploadSecret(secretName, envString);
  
  if (result.success) {
    console.log(`   ✅ ${secretName} uploaded successfully\n`);
  } else {
    console.error(`\n❌ Failed to upload ${secretName}: ${result.error}`);
    process.exit(1);
  }
}

module.exports = secrets;
