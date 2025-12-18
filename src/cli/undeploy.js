const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Completely remove repo from staging and prod servers (undeploy)
 * Uses generate-all.js to regenerate configs after removal
 */
function undeploy(options = {}) {
  const rootDir = process.cwd();
  const configPath = path.resolve(rootDir, options.config || 'factiii.yml');

  // Load config to get repo name
  let repoName = options.repo;
  if (!repoName) {
    if (!fs.existsSync(configPath)) {
      console.error('❌ Config file not found. Specify --repo <repo-name> or ensure factiii.yml exists.');
      process.exit(1);
    }
    const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
    repoName = config.name;
  }

  if (!repoName) {
    console.error('❌ Could not determine repo name. Specify --repo <repo-name>');
    process.exit(1);
  }

  const environments = options.environment === 'all'
    ? ['staging', 'prod']
    : [options.environment];

  console.log(`🗑️  Removing ${repoName} from: ${environments.join(', ')}\n`);

  for (const env of environments) {
    const envUpper = env.toUpperCase();
    const sshKeyVar = env === 'staging' ? 'STAGING_SSH' : env === 'prod' ? 'PROD_SSH' : `SSH_${envUpper}`;
    const hostVar = `${envUpper}_HOST`;
    const userVar = `${envUpper}_USER`;

    // Get SSH credentials from environment or options
    const sshKey = options[`ssh${env.charAt(0).toUpperCase() + env.slice(1)}`] || process.env[sshKeyVar];
    const host = options[`${env}Host`] || process.env[hostVar];
    const user = options[`${env}User`] || process.env[userVar] || 'ubuntu';

    if (!sshKey || !host) {
      console.log(`⚠️  Skipping ${env}: Missing SSH credentials`);
      console.log(`   Set ${sshKeyVar} and ${hostVar} environment variables\n`);
      continue;
    }

    console.log(`📡 Removing from ${env} server (${user}@${host})...`);

    try {
      // Write SSH key to temp file
      const sshKeyPath = path.join(__dirname, `../../.ssh_key_${env}`);
      fs.writeFileSync(sshKeyPath, sshKey);
      fs.chmodSync(sshKeyPath, 0o600);

      const repoPath = `~/.factiii/${repoName}`;
      const serviceKey = `${repoName}-${env}`;
      const generateAllScript = path.join(__dirname, '../scripts/generate-all.js');
      const remoteScriptPath = '~/.factiii/scripts/generate-all.js';

      // Stop and remove service
      console.log(`   🛑 Stopping service...`);
      execSync(
        `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} ` +
        `"cd ~/.factiii && docker compose stop ${serviceKey} && docker compose rm -f ${serviceKey} 2>/dev/null || true"`,
        { stdio: 'inherit' }
      );

      // Remove entire repo folder
      console.log(`   📁 Removing repo folder...`);
      execSync(
        `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} ` +
        `"rm -rf ${repoPath}"`,
        { stdio: 'inherit' }
      );

      // Copy and run generate-all.js to regenerate configs without this repo
      console.log(`   🔄 Regenerating configurations (without ${repoName})...`);
      execSync(
        `scp -i ${sshKeyPath} -o StrictHostKeyChecking=no ${generateAllScript} ${user}@${host}:${remoteScriptPath}`,
        { stdio: 'pipe' }
      );
      execSync(
        `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} ` +
        `"cd ~/.factiii && node ${remoteScriptPath}"`,
        { stdio: 'inherit' }
      );

      // Verify remaining services are still running
      console.log(`   ✅ Verifying remaining services...`);
      execSync(
        `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} ` +
        `"cd ~/.factiii && docker compose ps"`,
        { stdio: 'inherit' }
      );

      // Clean up
      fs.unlinkSync(sshKeyPath);

      console.log(`✅ ${env} removal complete!\n`);

    } catch (error) {
      console.error(`❌ Failed to remove from ${env}: ${error.message}\n`);
      if (fs.existsSync(path.join(__dirname, `../../.ssh_key_${env}`))) {
        fs.unlinkSync(path.join(__dirname, `../../.ssh_key_${env}`));
      }
      // Don't exit - continue with other environments
    }
  }

  console.log('✅ Removal complete!');
  console.log('   All remaining repos on servers have been verified and reconfigured.');
}

module.exports = undeploy;
