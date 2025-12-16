const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const validate = require('./validate');
const Deployer = require('./deployer');

/**
 * Deploy by validating local config and deploying directly via SSH
 */
async function deploy(options = {}) {
  const rootDir = process.cwd();
  const configPath = path.resolve(rootDir, options.config || 'core.yml');

  console.log('🔍 Validating local repository configuration...\n');

  // Step 1: Check core.yml exists
  if (!fs.existsSync(configPath)) {
    console.error(`❌ Config file not found: ${configPath}`);
    console.error('   Run: npx core init');
    process.exit(1);
  }
  console.log('✅ Found core.yml');

  // Step 2: Validate core.yml (includes EXAMPLE- check now)
  console.log('🔍 Validating core.yml...');
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

  // Check for required secrets
  const missingSecrets = checkRequiredSecrets(environments[0] === 'all' ? Object.keys(config.environments) : environments);
  
  if (missingSecrets.length > 0) {
    console.error('❌ Missing required secrets:\n');
    missingSecrets.forEach(secret => console.error(`   - ${secret}`));
    console.error('\n💡 Set secrets as environment variables or run: npx core init fix\n');
    process.exit(1);
  }

  // Create deployer instance
  const deployer = new Deployer(config, options);

  console.log('══════════════════════════════════════════════════════════════════════');
  console.log('🚀 Starting Direct Deployment');
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

/**
 * Check if required secrets are available
 */
function checkRequiredSecrets(environments) {
  const missing = [];

  for (const env of environments) {
    const prefix = env.toUpperCase();
    
    // Check SSH credentials
    if (!process.env[`${prefix}_SSH_KEY`] && !process.env[`${prefix}_SSH`]) {
      missing.push(`${prefix}_SSH_KEY (or ${prefix}_SSH)`);
    }
    
    if (!process.env[`${prefix}_HOST`]) {
      missing.push(`${prefix}_HOST`);
    }

    // USER is optional (defaults to ubuntu)
    // ENVS is optional but recommended
  }

  return missing;
}

module.exports = deploy;
