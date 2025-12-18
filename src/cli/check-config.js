const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Check and regenerate configurations on remote servers
 * Uses generate-all.js to scan ~/.factiii/*/factiii.yml and regenerate merged configs
 */
function checkConfig(options = {}) {
  const environments = options.environment === 'all' 
    ? ['staging', 'prod'] 
    : [options.environment];

  console.log('🔍 Checking configurations on servers...\n');
  console.log('='.repeat(60));

  const reports = {};

  for (const env of environments) {
    // Standardize secret names: STAGING_SSH, PROD_SSH
    const envUpper = env.toUpperCase();
    const sshKeyVar = env === 'staging' ? 'STAGING_SSH' : env === 'prod' ? 'PROD_SSH' : `SSH_${envUpper}`;
    const hostVar = `${envUpper}_HOST`;
    const userVar = `${envUpper}_USER`;

    // Get SSH credentials from environment or options
    const sshKey = options[`ssh${env.charAt(0).toUpperCase() + env.slice(1)}`] || process.env[sshKeyVar];
    const host = options[`${env}Host`] || process.env[hostVar];
    const user = options[`${env}User`] || process.env[userVar] || 'ubuntu';

    if (!sshKey || !host) {
      console.log(`\n⚠️  Skipping ${env}: Missing SSH credentials`);
      console.log(`   Set ${sshKeyVar} and ${hostVar} environment variables`);
      console.log(`   Or use --ssh-${env} and --${env}-host options\n`);
      reports[env] = { skipped: true, reason: 'Missing SSH credentials' };
      continue;
    }

    console.log(`\n📡 Checking ${env.toUpperCase()} server (${user}@${host})...`);
    console.log('-'.repeat(60));

    const report = {
      environment: env,
      host,
      user,
      repos: [],
      issues: [],
      warnings: [],
      fixes: [],
      services: []
    };

    try {
      // Write SSH key to temp file
      const sshKeyPath = path.join(__dirname, `../../.ssh_key_${env}`);
      fs.writeFileSync(sshKeyPath, sshKey);
      fs.chmodSync(sshKeyPath, 0o600);

      const generateAllScript = path.join(__dirname, '../scripts/generate-all.js');
      const remoteScriptPath = '~/.factiii/scripts/generate-all.js';
      const infraDir = '~/.factiii';

      // Ensure infrastructure directory exists
      console.log('   📁 Ensuring infrastructure directory exists...');
      execSync(
        `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} ` +
        `"mkdir -p ~/.factiii/scripts"`,
        { stdio: 'pipe' }
      );

      // List repo directories with factiii.yml
      console.log('   📋 Scanning for repos...');
      const repoListOutput = execSync(
        `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} ` +
        `"for dir in ~/.factiii/*/; do [ -f \\"\\\$dir/factiii.yml\\" ] && basename \\"\\\$dir\\"; done 2>/dev/null || echo ''"`,
        { encoding: 'utf8', stdio: 'pipe' }
      ).trim();

      const repos = repoListOutput ? repoListOutput.split('\n').filter(r => r.trim()) : [];
      
      if (repos.length === 0) {
        report.warnings.push('No repos found in ~/.factiii/');
        console.log('   ⚠️  No repos found');
      } else {
        console.log(`   ✅ Found ${repos.length} repo(s): ${repos.join(', ')}`);
        
        // Check each repo
        for (const repoName of repos) {
          const repoPath = `${infraDir}/${repoName}`;
          const envFile = `${repoPath}/.env.${env}`;

          try {
            // Check if factiii.yml is valid
            const configContent = execSync(
              `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} ` +
              `"cat ${repoPath}/factiii.yml"`,
              { encoding: 'utf8', stdio: 'pipe' }
            );

            const config = yaml.load(configContent);
            const repoInfo = {
              name: repoName,
              valid: true,
              hasEnvFile: false
            };

            // Check if env file exists in repo folder
            const envFileExists = execSync(
              `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} ` +
              `"test -f ${envFile} && echo 'yes' || echo 'no'"`,
              { encoding: 'utf8', stdio: 'pipe' }
            ).trim() === 'yes';
            
            repoInfo.hasEnvFile = envFileExists;

            if (!envFileExists) {
              report.warnings.push(`Missing env file: ${envFile}`);
            }

            report.repos.push(repoInfo);
            console.log(`      ✅ ${repoName}: Valid${envFileExists ? '' : ' (no env file)'}`);

          } catch (error) {
            report.issues.push(`Invalid config for ${repoName}: ${error.message}`);
            console.log(`      ❌ ${repoName}: Invalid - ${error.message}`);
          }
        }
      }

      // Copy generate-all.js script to server
      console.log('   📦 Copying generate-all.js...');
      execSync(
        `scp -i ${sshKeyPath} -o StrictHostKeyChecking=no ${generateAllScript} ${user}@${host}:${remoteScriptPath}`,
        { stdio: 'pipe' }
      );

      // Run generate-all.js to regenerate docker-compose.yml and nginx.conf
      console.log('   🔄 Regenerating docker-compose.yml and nginx.conf...');
      try {
        const generateOutput = execSync(
          `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} ` +
          `"cd ${infraDir} && node ${remoteScriptPath}"`,
          { encoding: 'utf8', stdio: 'pipe' }
        );
        report.fixes.push('Regenerated docker-compose.yml and nginx.conf');
        console.log('   ✅ Configs regenerated');
      } catch (error) {
        report.issues.push(`Failed to regenerate configs: ${error.message}`);
        console.log(`   ⚠️  Config regeneration had issues: ${error.message}`);
      }

      // Check service status
      console.log('   🐳 Checking service status...');
      try {
        execSync(
          `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} ` +
          `"cd ${infraDir} && docker compose ps --format json 2>/dev/null || docker compose ps"`,
          { encoding: 'utf8', stdio: 'pipe' }
        );
        report.services.push('Services checked');
        console.log('   ✅ Service status checked');
      } catch (error) {
        report.warnings.push(`Could not check service status: ${error.message}`);
      }

      // Clean up
      fs.unlinkSync(sshKeyPath);

      reports[env] = report;
      console.log(`\n✅ ${env.toUpperCase()} check complete`);

    } catch (error) {
      console.error(`\n❌ Failed to check ${env} configuration: ${error.message}`);
      report.issues.push(`Connection/execution error: ${error.message}`);
      reports[env] = report;
      if (fs.existsSync(path.join(__dirname, `../../.ssh_key_${env}`))) {
        fs.unlinkSync(path.join(__dirname, `../../.ssh_key_${env}`));
      }
    }
  }

  // Print comprehensive report
  console.log('\n' + '='.repeat(60));
  console.log('📊 COMPREHENSIVE REPORT');
  console.log('='.repeat(60));

  for (const [env, report] of Object.entries(reports)) {
    if (report.skipped) {
      console.log(`\n⚠️  ${env.toUpperCase()}: SKIPPED - ${report.reason}`);
      continue;
    }

    console.log(`\n📋 ${env.toUpperCase()} (${report.host})`);
    console.log('-'.repeat(60));
    
    console.log(`   Repos found: ${report.repos.length}`);
    report.repos.forEach(r => {
      console.log(`      - ${r.name}: ${r.valid ? '✅ Valid' : '❌ Invalid'}${r.hasEnvFile ? '' : ' (no env file)'}`);
    });

    if (report.fixes.length > 0) {
      console.log(`\n   ✅ Fixes applied: ${report.fixes.length}`);
      report.fixes.forEach(f => console.log(`      - ${f}`));
    }

    if (report.warnings.length > 0) {
      console.log(`\n   ⚠️  Warnings: ${report.warnings.length}`);
      report.warnings.forEach(w => console.log(`      - ${w}`));
    }

    if (report.issues.length > 0) {
      console.log(`\n   ❌ Issues: ${report.issues.length}`);
      report.issues.forEach(i => console.log(`      - ${i}`));
    }
  }

  // Summary
  const totalIssues = Object.values(reports).reduce((sum, r) => sum + (r.issues?.length || 0), 0);
  const totalWarnings = Object.values(reports).reduce((sum, r) => sum + (r.warnings?.length || 0), 0);
  const totalFixes = Object.values(reports).reduce((sum, r) => sum + (r.fixes?.length || 0), 0);

  console.log('\n' + '='.repeat(60));
  console.log('📈 SUMMARY');
  console.log('='.repeat(60));
  console.log(`   ✅ Fixes applied: ${totalFixes}`);
  console.log(`   ⚠️  Warnings: ${totalWarnings}`);
  console.log(`   ❌ Issues: ${totalIssues}`);

  if (totalIssues === 0 && totalWarnings === 0) {
    console.log('\n✅ All configurations are valid and up to date!');
  } else if (totalIssues === 0) {
    console.log('\n⚠️  Some warnings found, but no critical issues.');
  } else {
    console.log('\n❌ Some issues need attention. Please review the report above.');
    process.exit(1);
  }
}

module.exports = checkConfig;
