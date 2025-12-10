const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const validate = require('./validate');

/**
 * Deploy infrastructure.yml config to server(s)
 */
function deploy(options = {}) {
  const rootDir = process.cwd();
  const configPath = path.resolve(rootDir, options.config || 'infrastructure.yml');

  // Validate config first
  console.log('🔍 Validating configuration...\n');
  try {
    validate({ config: configPath });
  } catch (error) {
    console.error('❌ Config validation failed. Fix errors before deploying.\n');
    process.exit(1);
  }

  // Load config to get repo name
  const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
  const repoName = config.name;

  if (!repoName) {
    console.error('❌ Config must have a "name" field');
    process.exit(1);
  }

  const environments = options.environment === 'all'
    ? Object.keys(config.environments || {})
    : [options.environment];

  if (environments.length === 0) {
    console.error('❌ No environments found in config');
    process.exit(1);
  }

  console.log(`🚀 Deploying ${repoName} to: ${environments.join(', ')}\n`);

  for (const env of environments) {
    if (!config.environments || !config.environments[env]) {
      console.log(`⚠️  Skipping ${env}: Not configured in infrastructure.yml\n`);
      continue;
    }

    const envUpper = env.toUpperCase();
    const sshKeyVar = env === 'staging' ? 'STAGING_SSH' : env === 'prod' ? 'PROD_SSH' : `SSH_${envUpper}`;
    const hostVar = `${envUpper}_HOST`;
    const userVar = `${envUpper}_USER`;
    const envsVar = `${envUpper}_ENVS`;

    // Get SSH credentials from environment or options
    const sshKey = options[`ssh${env.charAt(0).toUpperCase() + env.slice(1)}`] || process.env[sshKeyVar];
    const host = options[`${env}Host`] || process.env[hostVar];
    const user = options[`${env}User`] || process.env[userVar] || 'ubuntu';
    const envVars = process.env[envsVar];

    if (!sshKey || !host) {
      console.log(`⚠️  Skipping ${env}: Missing SSH credentials`);
      console.log(`   Set ${sshKeyVar} and ${hostVar} environment variables\n`);
      continue;
    }

    console.log(`📡 Deploying to ${env} server (${user}@${host})...`);

    try {
      // Write SSH key to temp file
      const sshKeyPath = path.join(__dirname, `../../.ssh_key_${env}`);
      fs.writeFileSync(sshKeyPath, sshKey);
      fs.chmodSync(sshKeyPath, 0o600);

      const remoteConfigPath = `~/infrastructure/configs/${repoName}.yml`;
      const serviceKey = `${repoName}-${env}`;
      const remoteEnvPath = `~/infrastructure/${serviceKey}.env`;

      // Ensure infrastructure directory exists
      execSync(
        `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} ` +
        `"mkdir -p ~/infrastructure/configs ~/infrastructure/scripts/generators ~/infrastructure/nginx"`,
        { stdio: 'inherit' }
      );

      // Copy config file
      console.log(`   📝 Copying config file...`);
      execSync(
        `scp -i ${sshKeyPath} -o StrictHostKeyChecking=no ${configPath} ${user}@${host}:${remoteConfigPath}`,
        { stdio: 'inherit' }
      );

      // Write env file if provided
      if (envVars) {
        console.log(`   🔐 Writing environment variables...`);
        // Write to temp file first, then copy via SSH
        const tempEnvFile = path.join(__dirname, `../../.env_temp_${env}`);
        fs.writeFileSync(tempEnvFile, envVars);
        execSync(
          `scp -i ${sshKeyPath} -o StrictHostKeyChecking=no ${tempEnvFile} ${user}@${host}:${remoteEnvPath}`,
          { stdio: 'inherit' }
        );
        // Set secure permissions
        execSync(
          `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} ` +
          `"chmod 600 ${remoteEnvPath}"`,
          { stdio: 'inherit' }
        );
        fs.unlinkSync(tempEnvFile);
      }

      // Copy generators if needed
      const generatorsDir = path.join(__dirname, '../generators');
      execSync(
        `scp -i ${sshKeyPath} -o StrictHostKeyChecking=no -r ${generatorsDir}/* ${user}@${host}:~/infrastructure/scripts/generators/ 2>/dev/null || true`,
        { stdio: 'inherit' }
      );

      // Run check-config to regenerate docker-compose and nginx
      console.log(`   🔄 Regenerating configurations...`);
      const scriptPath = path.join(__dirname, '../scripts/check-config.sh');
      const remoteScriptPath = '~/infrastructure/scripts/check-config.sh';
      
      // Copy script if needed
      execSync(
        `scp -i ${sshKeyPath} -o StrictHostKeyChecking=no ${scriptPath} ${user}@${host}:${remoteScriptPath} 2>/dev/null || true`,
        { stdio: 'inherit' }
      );

      execSync(
        `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} ` +
        `"chmod +x ${remoteScriptPath} && cd ~/infrastructure && INFRA_DIR=~/infrastructure ${remoteScriptPath}"`,
        { stdio: 'inherit' }
      );

      // Pull latest image and restart service
      console.log(`   🐳 Pulling latest image and restarting service...`);
      execSync(
        `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} ` +
        `"cd ~/infrastructure && docker compose pull ${serviceKey} && docker compose up -d ${serviceKey}"`,
        { stdio: 'inherit' }
      );

      // Clean up
      fs.unlinkSync(sshKeyPath);

      console.log(`✅ ${env} deployment complete!\n`);

    } catch (error) {
      console.error(`❌ Failed to deploy to ${env}: ${error.message}\n`);
      if (fs.existsSync(path.join(__dirname, `../../.ssh_key_${env}`))) {
        fs.unlinkSync(path.join(__dirname, `../../.ssh_key_${env}`));
      }
      process.exit(1);
    }
  }

  console.log('✅ Deployment complete!');
}

module.exports = deploy;
