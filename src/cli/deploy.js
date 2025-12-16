const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const validate = require('./validate');
const Deployer = require('./deployer');
const { GitHubSecretsStore } = require('../utils/github-secrets');

/**
 * Deploy by triggering GitHub Actions workflow
 * Validates config and GitHub secrets, then triggers workflow
 */
async function deploy(options = {}) {
  const rootDir = process.cwd();
  const configPath = path.resolve(rootDir, options.config || 'factiii.yml');

  console.log('🔍 Validating local repository configuration...\n');

  // Step 1: Check factiii.yml exists
  if (!fs.existsSync(configPath)) {
    console.error(`❌ Config file not found: ${configPath}`);
    console.error('   Run: npx factiii init');
    process.exit(1);
  }
  console.log('✅ Found factiii.yml');

  // Step 2: Validate factiii.yml (includes EXAMPLE- check now)
  console.log('🔍 Validating factiii.yml...');
  try {
    validate({ config: configPath });
  } catch (error) {
    console.error('❌ Config validation failed. Fix errors before deploying.\n');
    process.exit(1);
  }

  // Load config
  const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
  const repoName = config.name;

  if (!repoName) {
    console.error('❌ Config must have a "name" field');
    process.exit(1);
  }

  // Determine which environments to deploy
  const environments = options.environment === 'all'
    ? Object.keys(config.environments || {})
    : options.environment ? [options.environment] : ['all'];

  if (environments.length === 0 || (environments[0] === 'all' && Object.keys(config.environments || {}).length === 0)) {
    console.error('❌ No environments found in config');
    process.exit(1);
  }

  console.log(`\n📦 Repository: ${repoName}`);
  console.log(`🌍 Environments: ${environments.join(', ')}\n`);

  // Step 3: Check GitHub secrets exist
  console.log('🔍 Checking GitHub secrets...\n');
  
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('❌ GITHUB_TOKEN required for deployment');
    console.error('');
    console.error('   Generate token: https://github.com/settings/tokens');
    console.error('   → Select scopes: repo + workflow');
    console.error('');
    console.error('   Add to your shell config:');
    console.error('   export GITHUB_TOKEN=ghp_your_token_here');
    console.error('');
    process.exit(1);
  }

  const secretStore = new GitHubSecretsStore(token);
  const envsToCheck = environments[0] === 'all' ? Object.keys(config.environments) : environments;
  
  // Build required secrets list (minimal - only truly secret values)
  // HOST is in factiii.yml, USER defaults to ubuntu in factiiiAuto.yml
  // AWS_ACCESS_KEY_ID and AWS_REGION are in factiii.yml (not secret)
  const requiredSecrets = [];
  for (const env of envsToCheck) {
    const prefix = env.toUpperCase();
    requiredSecrets.push(`${prefix}_SSH`);  // SSH private key only
  }
  
  // Only AWS_SECRET_ACCESS_KEY needs to be a secret
  requiredSecrets.push('AWS_SECRET_ACCESS_KEY');

  // Check secrets
  const check = await secretStore.checkSecrets(requiredSecrets);
  
  if (check.error) {
    console.error(`❌ Failed to check GitHub secrets: ${check.error}\n`);
    process.exit(1);
  }

  if (check.missing.length > 0) {
    console.error('❌ Missing required GitHub secrets:\n');
    check.missing.forEach(name => console.error(`   - ${name}`));
    console.error('');
    console.error('💡 Run: npx factiii init fix');
    console.error('   This will prompt for missing secrets and upload them to GitHub.\n');
    process.exit(1);
  }

  console.log('✅ All required secrets exist in GitHub\n');

  // Create deployer instance (triggers workflow)
  const deployer = new Deployer(config, options);

  console.log('══════════════════════════════════════════════════════════════════════');
  console.log('🚀 Starting Workflow-Based Deployment');
  console.log('══════════════════════════════════════════════════════════════════════\n');

  try {
    // Deploy!
    const results = await deployer.deploy(environments);

    // Show summary
    console.log('\n══════════════════════════════════════════════════════════════════════');
    console.log('📊 Deployment Summary');
    console.log('══════════════════════════════════════════════════════════════════════\n');

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    if (successful.length > 0) {
      console.log('✅ Successful deployments:');
      successful.forEach(r => {
        console.log(`   - ${r.environment}: ${r.message || 'Deployed'}`);
      });
      console.log('');
    }

    if (failed.length > 0) {
      console.log('❌ Failed deployments:');
      failed.forEach(r => {
        console.log(`   - ${r.environment}: ${r.error}`);
      });
      console.log('');
      process.exit(1);
    }

    console.log('✨ All deployments completed successfully!\n');

  } catch (error) {
    console.error('\n❌ Deployment failed:', error.message);
    console.error('');
    process.exit(1);
  }
}

module.exports = deploy;
