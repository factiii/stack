const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

function checkConfig(options = {}) {
  const environments = options.environment === 'all' 
    ? ['staging', 'prod'] 
    : [options.environment];

  console.log('🔍 Checking configurations on servers...\n');
  console.log('=' .repeat(60));

  const reports = {};

  for (const env of environments) {
    // Standardize secret names: STAGING_SSH, PROD_SSH
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
      configs: [],
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

      const generatorsDir = path.join(__dirname, '../generators');
      const scriptPath = path.join(__dirname, '../scripts/check-config.sh');
      const remoteScriptPath = '~/infrastructure/scripts/check-config.sh';
      const configsDir = '~/infrastructure/configs';
      const infraDir = '~/infrastructure';

      // Ensure infrastructure directory exists
      console.log('   📁 Ensuring infrastructure directory exists...');
      execSync(
        `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} ` +
        `"mkdir -p ${configsDir} ~/infrastructure/scripts/generators ~/infrastructure/nginx"`,
        { stdio: 'pipe' }
      );

      // List config files
      console.log('   📋 Checking config files...');
      const configFilesOutput = execSync(
        `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} ` +
        `"ls -1 ${configsDir}/*.yml ${configsDir}/*.yaml 2>/dev/null || echo ''"`,
        { encoding: 'utf8', stdio: 'pipe' }
      ).trim();

      const configFiles = configFilesOutput ? configFilesOutput.split('\n').filter(f => f.trim()) : [];
      
      if (configFiles.length === 0) {
        report.warnings.push('No config files found on server');
        console.log('   ⚠️  No config files found');
      } else {
        console.log(`   ✅ Found ${configFiles.length} config file(s)`);
        
        // Validate each config
        for (const configFile of configFiles) {
          const repoName = path.basename(configFile, path.extname(configFile));
          const serviceKey = `${repoName}-${env}`;
          const envFile = `${infraDir}/${serviceKey}.env`;

          try {
            const configContent = execSync(
              `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} ` +
              `"cat ${configFile}"`,
              { encoding: 'utf8', stdio: 'pipe' }
            );

            const config = yaml.load(configContent);
            const configInfo = {
              repo: repoName,
              file: configFile,
              valid: true,
              hasEnvFile: false,
              envFileExists: false
            };

            // Check if env file is needed and exists
            if (config.environments && config.environments[env] && config.environments[env].env_file) {
              configInfo.hasEnvFile = true;
              const envFileExists = execSync(
                `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} ` +
                `"test -f ${envFile} && echo 'yes' || echo 'no'"`,
                { encoding: 'utf8', stdio: 'pipe' }
              ).trim() === 'yes';
              configInfo.envFileExists = envFileExists;

              if (!envFileExists) {
                const envVarName = `${repoName.toUpperCase().replace(/-/g, '_')}_${envUpper}_ENVS`;
                report.issues.push(`Missing env file for ${repoName}: ${envFile} (check GitHub secret: ${envVarName})`);
              }
            }

            // Check GitHub secrets availability (local check)
            const expectedSecretName = `${repoName.toUpperCase().replace(/-/g, '_')}_${envUpper}_ENVS`;
            if (configInfo.hasEnvFile && !process.env[expectedSecretName] && !envVars) {
              report.warnings.push(`GitHub secret ${expectedSecretName} not found in local environment (may be set in GitHub Actions)`);
            }

            report.configs.push(configInfo);
            console.log(`      ✅ ${repoName}: Valid`);

          } catch (error) {
            report.issues.push(`Invalid config: ${configFile} - ${error.message}`);
            console.log(`      ❌ ${repoName}: Invalid - ${error.message}`);
          }
        }
      }

      // Copy generators and script
      console.log('   📦 Copying generators and scripts...');
      execSync(
        `scp -i ${sshKeyPath} -o StrictHostKeyChecking=no -r ${generatorsDir}/* ${user}@${host}:~/infrastructure/scripts/generators/ 2>/dev/null || true`,
        { stdio: 'pipe' }
      );
      execSync(
        `scp -i ${sshKeyPath} -o StrictHostKeyChecking=no ${scriptPath} ${user}@${host}:${remoteScriptPath} 2>/dev/null || true`,
        { stdio: 'pipe' }
      );

      // Run check-config script to regenerate configs
      console.log('   🔄 Regenerating docker-compose.yml and nginx.conf...');
      try {
        const checkOutput = execSync(
          `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${user}@${host} ` +
          `"chmod +x ${remoteScriptPath} && cd ${infraDir} && INFRA_DIR=${infraDir} ${remoteScriptPath}"`,
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
        const servicesOutput = execSync(
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
    
    console.log(`   Configs found: ${report.configs.length}`);
    report.configs.forEach(c => {
      console.log(`      - ${c.repo}: ${c.valid ? '✅ Valid' : '❌ Invalid'}`);
      if (c.hasEnvFile) {
        console.log(`        Env file: ${c.envFileExists ? '✅ Exists' : '❌ Missing'}`);
      }
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
