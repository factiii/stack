const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const scan = require('./scan');
const { 
  getPlugin, 
  createSecretStore
} = require('../plugins');
const { GitHubSecretsStore } = require('../plugins/secrets/github');
const { parseEnvFile } = require('../utils/env-validator');
const { 
  confirm, 
  promptSingleLine, 
  promptMultiLine 
} = require('../utils/secret-prompts');

/**
 * Convert env object to newline-separated key=value string
 */
function envObjectToString(env) {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

/**
 * Get secret validation for a given type
 */
function getSecretValidation(type) {
  const validations = {
    ssh_key: (value) => {
      if (!value || value.trim().length === 0) {
        return { valid: false, error: 'SSH key cannot be empty' };
      }
      if (!value.includes('BEGIN') || !value.includes('PRIVATE KEY')) {
        return { valid: false, error: 'Invalid SSH key format (missing BEGIN/PRIVATE KEY markers)' };
      }
      return { valid: true };
    },
    hostname: (value) => {
      if (!value || value.trim().length === 0) {
        return { valid: false, error: 'Hostname cannot be empty' };
      }
      if (value.includes(' ')) {
        return { valid: false, error: 'Hostname cannot contain spaces' };
      }
      return { valid: true };
    },
    username: (value) => {
      if (!value || value.trim().length === 0) {
        return { valid: true, defaultValue: 'ubuntu' };
      }
      if (value.includes(' ')) {
        return { valid: false, error: 'Username cannot contain spaces' };
      }
      return { valid: true };
    },
    aws_key: (value) => {
      if (!value || value.trim().length === 0) {
        return { valid: false, error: 'AWS Access Key ID cannot be empty' };
      }
      if (!value.startsWith('AKIA')) {
        return { valid: false, error: 'AWS Access Key ID should start with AKIA' };
      }
      if (value.length !== 20) {
        return { valid: false, error: 'AWS Access Key ID should be 20 characters long' };
      }
      return { valid: true };
    },
    aws_secret: (value) => {
      if (!value || value.trim().length === 0) {
        return { valid: false, error: 'AWS Secret Access Key cannot be empty' };
      }
      if (value.length !== 40) {
        return { valid: false, error: 'AWS Secret Access Key should be 40 characters long' };
      }
      return { valid: true };
    },
    aws_region: (value) => {
      if (!value || value.trim().length === 0) {
        return { valid: false, error: 'AWS region cannot be empty' };
      }
      if (!/^[a-z]{2}-[a-z]+-\d+$/.test(value)) {
        return { valid: false, error: 'Invalid AWS region format (e.g., us-east-1)' };
      }
      return { valid: true };
    },
    generic: (value) => {
      if (!value || value.trim().length === 0) {
        return { valid: false, error: 'Value cannot be empty' };
      }
      return { valid: true };
    }
  };
  
  return validations[type] || validations.generic;
}

/**
 * Prompt for a secret using plugin help text
 */
async function promptForPluginSecret(secret, serverPlugin) {
  const { name, envVar, type, description, default: defaultValue } = secret;
  
  // Get help text from plugin if available
  const helpText = serverPlugin?.helpText?.[name] || `Enter value for ${envVar}:`;
  
  console.log(`\n🔑 ${envVar}`);
  console.log(`   ${description || name}`);
  console.log(helpText);
  
  let value;
  let isValid = false;
  let attempts = 0;
  const maxAttempts = 3;
  const validate = getSecretValidation(type);
  
  while (!isValid && attempts < maxAttempts) {
    attempts++;
    
    // Multi-line input for SSH keys
    if (type === 'ssh_key') {
      value = await promptMultiLine('');
    } else {
      const prompt = defaultValue ? `   > [${defaultValue}] ` : '   > ';
      value = await promptSingleLine(prompt);
    }
    
    // Use default if empty and default exists
    if ((!value || value.trim() === '') && defaultValue) {
      value = defaultValue;
      console.log(`   Using default: ${value}`);
    }
    
    // Validate
    const validation = validate(value);
    
    if (validation.valid) {
      isValid = true;
      if (validation.defaultValue && (!value || value.trim().length === 0)) {
        value = validation.defaultValue;
        console.log(`   Using default: ${value}`);
      }
      console.log('   ✅ Valid input\n');
    } else {
      console.error(`   ❌ ${validation.error}`);
      if (attempts < maxAttempts) {
        console.log(`   Please try again (${attempts}/${maxAttempts})...\n`);
      } else {
        throw new Error(`Maximum attempts reached for ${envVar}`);
      }
    }
  }
  
  return value;
}

/**
 * Parse environments from factiii.yml config
 */
function parseEnvironments(config) {
  const environments = [];
  
  // Check for new environments format
  if (config.environments) {
    for (const [envName, envConfig] of Object.entries(config.environments)) {
      environments.push({
        name: envName,
        server: envConfig.server || (envName === 'staging' ? 'mac-mini' : 'aws-ec2'),
        ...envConfig
      });
    }
  } else {
    // Legacy format - detect staging and production from config
    if (config.staging_domain || config.staging_host) {
      environments.push({
        name: 'staging',
        server: 'mac-mini',
        domain: config.staging_domain,
        host: config.staging_host
      });
    }
    
    if (config.prod_domain || config.domain || config.prod_host) {
      environments.push({
        name: 'production',
        server: 'aws-ec2',
        domain: config.prod_domain || config.domain,
        host: config.prod_host
      });
    }
  }
  
  // Default to staging + production if nothing detected
  if (environments.length === 0) {
    environments.push(
      { name: 'staging', server: 'mac-mini' },
      { name: 'production', server: 'aws-ec2' }
    );
  }
  
  return environments;
}

/**
 * Collect all required secrets from environments
 * 
 * Simplified secrets (per plan):
 * - {ENV}_SSH: SSH private key for each environment
 * - AWS_SECRET_ACCESS_KEY: Only truly secret AWS value
 * 
 * Not secrets (in factiii.yml):
 * - HOST: environments.{env}.host
 * - AWS_ACCESS_KEY_ID: aws.access_key_id  
 * - AWS_REGION: aws.region
 * 
 * Not secrets (in factiiiAuto.yml):
 * - USER: defaults to ubuntu
 */
function collectRequiredSecrets(environments) {
  const secrets = [];
  
  // Add SSH key for each environment
  for (const env of environments) {
    const prefix = env.name.toUpperCase();
    secrets.push({
      name: 'SSH',
      envVar: `${prefix}_SSH`,
      type: 'ssh_key',
      description: `SSH private key for ${env.name} server`,
      server: env.server,
      environment: env.name
    });
  }
  
  // Add AWS_SECRET_ACCESS_KEY (shared across all environments)
  secrets.push({
    name: 'AWS_SECRET_ACCESS_KEY',
    envVar: 'AWS_SECRET_ACCESS_KEY',
    type: 'aws_secret',
    description: 'AWS Secret Access Key',
    shared: true,
    environment: null
  });
  
  return secrets;
}

/**
 * Main fix function - fixes all environments including uploading secrets
 */
async function fix(options = {}) {
  const rootDir = process.cwd();
  const configPath = path.join(rootDir, 'factiii.yml');
  
  console.log('═'.repeat(70));
  console.log('🔧 INIT FIX: Automated Environment Setup');
  console.log('═'.repeat(70));
  console.log('');
  
  // Track what we fix
  const fixReport = {
    local: [],
    configMigration: null,  // NEW: Config version migration
    configSync: null,  // Config drift fixes
    dns: {},  // DNS hostname fixes
    github: [],
    servers: {},
    errors: []
  };
  
  // ============================================================
  // STAGE 1: CHECK EVERYTHING FIRST
  // ============================================================
  console.log('📋 Stage 1: Discovering Issues\n');
  console.log('   Running comprehensive check...\n');
  
  // Run scan to discover all issues
  const scanResult = await scan({ ...options, noRemote: true, skipWorkflow: true });
  const auditResults = scanResult.auditResults || {};
  
  console.log('\n' + '─'.repeat(70));
  console.log('');
  
  // Check if scan found critical issues - if so, exit before attempting fixes
  if (scanResult && scanResult.critical > 0) {
    console.error('❌ Scan found critical issues that must be fixed manually.');
    console.error('   Please address the issues shown above before running fix.');
    process.exit(1);
  }
  
  // Check if we have a config
  if (!fs.existsSync(configPath)) {
    console.error('❌ factiii.yml not found. Run: npx factiii');
    process.exit(1);
  }
  
  let config = yaml.load(fs.readFileSync(configPath, 'utf8'));
  
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
    console.error('   Or pass temporarily: npx factiii fix --token <token>');
    process.exit(1);
  }
  
  // Get repo info
  const repoInfo = GitHubSecretsStore.getRepoInfo();
  if (!repoInfo) {
    console.error('❌ Could not detect GitHub repository');
    console.error('   Make sure you are in a git repository with a GitHub remote');
    process.exit(1);
  }
  
  // Create secret store instance
  const secretStore = createSecretStore('github', {
    token,
    owner: repoInfo.owner,
    repo: repoInfo.repo
  });
  
  // Validate secret store access
  const storeValid = await secretStore.validate();
  if (!storeValid.valid) {
    console.error(`❌ Cannot access GitHub secrets: ${storeValid.error}`);
    process.exit(1);
  }
  
  console.log('═'.repeat(70));
  console.log(`🔧 Stage 2: Fixing Issues for ${repoInfo.owner}/${repoInfo.repo}`);
  console.log('═'.repeat(70));
  console.log('');
  
  // ============================================================
  // STAGE 2A: LOCAL ENVIRONMENT (already fixed by scan above)
  // ============================================================
  console.log('📦 Part 1: Local Environment');
  console.log('   ✅ Configs generated (done by scan)');
  console.log('   ✅ Dependencies validated');
  console.log('   ✅ All local files ready\n');
  fixReport.local.push('Local environment configured');
  
  // ============================================================
  // STAGE 2A1: CONFIG VERSION MIGRATION
  // ============================================================
  if (auditResults.configOutdated && auditResults.configOutdated.canAutoFix) {
    console.log('🔄 Part 1A: Config Version Migration\n');
    
    const { migrateConfig } = require('../utils/config-migrations');
    const { CURRENT_VERSION } = require('../utils/config-schema');
    
    try {
      const migrationResult = migrateConfig(
        config,
        auditResults.configOutdated.currentVersion || '1.0.0',
        CURRENT_VERSION
      );
      
      if (migrationResult.success) {
        // Write migrated config back to file
        const configPath = path.join(process.cwd(), 'factiii.yml');
        fs.writeFileSync(configPath, yaml.dump(migrationResult.config, { lineWidth: -1 }));
        
        console.log(`   ✅ Migrated from ${migrationResult.originalVersion} to ${migrationResult.targetVersion}\n`);
        
        if (migrationResult.migrationsApplied.length > 0) {
          console.log('   Applied migrations:');
          migrationResult.migrationsApplied.forEach(m => {
            console.log(`      - ${m.id}: ${m.description}`);
          });
          console.log('');
        }
        
        fixReport.configMigration = `Migrated to ${migrationResult.targetVersion}`;
        
        // Reload config after migration
        config = yaml.load(fs.readFileSync(configPath, 'utf8'));
      } else {
        console.log(`   ⚠️  Migration failed: ${migrationResult.errors.join(', ')}\n`);
        fixReport.errors.push('Config migration failed');
      }
    } catch (error) {
      console.log(`   ⚠️  Migration error: ${error.message}\n`);
      fixReport.errors.push('Config migration error');
    }
  }
  
  // Show new optional fields if any
  if (auditResults.configSchema && auditResults.configSchema.newOptional && auditResults.configSchema.newOptional.length > 0) {
    console.log('💡 New Optional Fields Available:\n');
    auditResults.configSchema.newOptional.forEach(field => {
      console.log(`   - ${field.path}`);
      console.log(`     ${field.description}`);
    });
    console.log('\n   These fields are optional - add them to factiii.yml if needed\n');
  }
  
  // ============================================================
  // STAGE 2A2: CONFIG DRIFT FIXES
  // ============================================================
  console.log('⚙️  Part 1B: Configuration Sync\n');

  const { validateConfigSync } = require('../utils/config-validator');
  const configSync = validateConfigSync(process.cwd());

  if (configSync.needsRegeneration || configSync.needsGeneration) {
    console.log('   🔧 Regenerating workflows to match factiii.yml...\n');
    
    try {
      const generateWorkflows = require('./generate-workflows');
      generateWorkflows({ output: '.github/workflows' });
      console.log('   ✅ Workflows regenerated\n');
      fixReport.configSync = 'Workflows regenerated';
    } catch (error) {
      console.log(`   ⚠️  Failed to regenerate workflows: ${error.message}\n`);
      fixReport.errors.push('Failed to regenerate workflows');
    }
  } else if (configSync.valid) {
    console.log('   ✅ Configuration in sync\n');
    fixReport.configSync = 'Already in sync';
  }

  // ============================================================
  // STAGE 2A3: DNS HOSTNAME FIXES
  // ============================================================
  console.log('🌐 Part 1B: DNS Hostname Validation\n');

  const { isHostnameResolvable, findResolvableAlternative } = require('../utils/dns-validator');

  let hostnameFixed = false;
  const environments = parseEnvironments(config);

  for (const env of environments) {
    const hostname = env.host;
    
    if (!hostname) {
      console.log(`   ⚠️  ${env.name}: No hostname configured\n`);
      continue;
    }
    
    console.log(`   🔍 Checking ${env.name}: ${hostname}...`);
    
    const isResolvable = await isHostnameResolvable(hostname);
    
    if (isResolvable) {
      console.log(`   ✅ ${env.name}: Hostname resolves correctly\n`);
      fixReport.dns[env.name] = 'Hostname valid';
    } else {
      console.log(`   ❌ ${env.name}: Hostname does not resolve`);
      
      // Try to find alternative
      const alternative = await findResolvableAlternative(hostname);
      
      if (alternative) {
        console.log(`   💡 Found alternative: ${alternative}`);
        console.log(`   🔧 Updating factiii.yml...\n`);
        
        // Update config
        config.environments[env.name].host = alternative;
        hostnameFixed = true;
        
        fixReport.dns[env.name] = `Fixed: ${hostname} → ${alternative}`;
      } else {
        console.log(`   ⚠️  No alternative found - please check DNS records\n`);
        fixReport.errors.push(`${env.name}: Hostname '${hostname}' does not resolve`);
      }
    }
  }

  // Write updated config if hostnames were fixed
  if (hostnameFixed) {
    const configPath = path.join(process.cwd(), 'factiii.yml');
    fs.writeFileSync(configPath, yaml.dump(config, { lineWidth: -1 }));
    console.log('   ✅ factiii.yml updated with corrected hostnames\n');
  }
  
  // ============================================================
  // STAGE 2B: PARSE ENVIRONMENTS AND COLLECT SECRETS
  // ============================================================
  
  console.log('🌍 Detected Environments:\n');
  for (const env of environments) {
    const ServerPlugin = getPlugin('server', env.server);
    const serverName = ServerPlugin?.name || env.server;
    console.log(`   - ${env.name} → ${serverName}`);
    fixReport.servers[env.name] = [];
  }
  console.log('');
  
  // Collect all required secrets (simplified: only SSH keys + AWS_SECRET_ACCESS_KEY)
  const allSecrets = collectRequiredSecrets(environments);
  
  // Add environment file secrets (optional - only if .env files exist)
  const stagingEnvPath = path.join(rootDir, '.env.staging');
  const prodEnvPath = path.join(rootDir, '.env.prod');
  
  if (fs.existsSync(stagingEnvPath)) {
    allSecrets.push({ name: 'STAGING_ENVS', envVar: 'STAGING_ENVS', type: 'env_file', optional: true });
  }
  if (fs.existsSync(prodEnvPath)) {
    allSecrets.push({ name: 'PROD_ENVS', envVar: 'PROD_ENVS', type: 'env_file', optional: true });
  }
  
  // ============================================================
  // STAGE 2C: CHECK WHICH SECRETS ARE MISSING
  // ============================================================
  console.log('🔐 Part 2: GitHub Secrets Upload\n');
  console.log('   🔍 Checking GitHub for missing secrets...\n');
  
  const secretsCheck = await secretStore.checkSecrets(allSecrets.map(s => s.envVar));
  
  if (secretsCheck.error) {
    console.error(`   ❌ ${secretsCheck.error}`);
    fixReport.errors.push(secretsCheck.error);
    if (!options.continueOnError) {
      process.exit(1);
    }
  }
  
  const missing = secretsCheck.missing || [];
  const present = secretsCheck.present || [];
  
  if (present.length > 0) {
    console.log(`   ✅ ${present.length} secret(s) already exist:`);
    present.forEach(s => console.log(`      - ${s}`));
    console.log('');
  }
  
  if (missing.length === 0) {
    console.log('   ✅ All secrets already exist in GitHub\n');
  } else {
    console.log(`   📝 Found ${missing.length} missing secret(s):\n`);
    missing.forEach(s => console.log(`      - ${s}`));
    console.log('');
    
    // Separate by type
    const envFileSecrets = missing.filter(s => s.includes('ENVS'));
    const infraSecrets = missing.filter(s => !s.includes('ENVS'));
    
    // ============================================================
    // Handle env file secrets first (read from files)
    // ============================================================
    for (const secretName of envFileSecrets) {
      const envFileName = secretName === 'STAGING_ENVS' ? '.env.staging' : '.env.prod';
      const envPath = path.join(rootDir, envFileName);
      
      if (!fs.existsSync(envPath)) {
        console.error(`   ❌ ${envFileName} required but not found`);
        console.error(`      Create ${envFileName} with your environment variables\n`);
        fixReport.errors.push(`${envFileName} not found`);
        if (!options.continueOnError) {
          process.exit(1);
        }
        continue;
      }
      
      console.log(`   📤 Uploading ${secretName} from ${envFileName}...`);
      const envData = parseEnvFile(envPath);
      
      if (!envData || Object.keys(envData).length === 0) {
        console.log(`      ⚠️  ${envFileName} is empty, skipping`);
        continue;
      }
      
      const envString = envObjectToString(envData);
      const result = await secretStore.uploadSecret(secretName, envString);
      
      if (result.success) {
        console.log(`      ✅ ${secretName} uploaded successfully`);
        console.log(`      📊 ${Object.keys(envData).length} environment variables\n`);
        fixReport.github.push(`${secretName} (${Object.keys(envData).length} vars)`);
      } else {
        console.error(`      ❌ Failed: ${result.error}\n`);
        fixReport.errors.push(`${secretName}: ${result.error}`);
        if (!options.continueOnError) {
          process.exit(1);
        }
      }
    }
    
    // ============================================================
    // Handle infrastructure secrets (prompt interactively)
    // ============================================================
    if (infraSecrets.length > 0) {
      console.log('   🔑 Infrastructure Secrets Setup\n');
      console.log('      The following secrets need to be configured:\n');
      infraSecrets.forEach(s => console.log(`         - ${s}`));
      console.log('');
      
      for (const secretName of infraSecrets) {
        // Find the secret definition
        const secretDef = allSecrets.find(s => s.envVar === secretName);
        
        if (!secretDef) {
          // Fallback to legacy prompting
          try {
            const value = await promptForSecret(secretName, config);
            
            console.log(`   📤 Uploading ${secretName}...`);
            const result = await secretStore.uploadSecret(secretName, value);
            
            if (result.success) {
              console.log(`   ✅ ${secretName} uploaded successfully\n`);
              fixReport.github.push(secretName);
            } else {
              console.error(`   ❌ Failed to upload ${secretName}: ${result.error}\n`);
              fixReport.errors.push(`${secretName}: ${result.error}`);
              if (!options.continueOnError) {
                process.exit(1);
              }
            }
          } catch (error) {
            console.error(`   ❌ Error prompting for ${secretName}: ${error.message}\n`);
            fixReport.errors.push(`${secretName}: ${error.message}`);
            if (!options.continueOnError) {
              process.exit(1);
            }
          }
          continue;
        }
        
        // Get the server plugin for help text
        const ServerPlugin = getPlugin('server', secretDef.server);
        
        try {
          const value = await promptForPluginSecret(secretDef, ServerPlugin);
          
          console.log(`   📤 Uploading ${secretName}...`);
          const result = await secretStore.uploadSecret(secretName, value);
          
          if (result.success) {
            console.log(`   ✅ ${secretName} uploaded successfully\n`);
            fixReport.github.push(secretName);
          } else {
            console.error(`   ❌ Failed to upload ${secretName}: ${result.error}\n`);
            fixReport.errors.push(`${secretName}: ${result.error}`);
            if (!options.continueOnError) {
              process.exit(1);
            }
          }
        } catch (error) {
          console.error(`   ❌ Error prompting for ${secretName}: ${error.message}\n`);
          fixReport.errors.push(`${secretName}: ${error.message}`);
          if (!options.continueOnError) {
            process.exit(1);
          }
        }
      }
    }
  }
  
  console.log('');
  
  // ============================================================
  // STAGE 2D: REMOTE SERVERS
  // ============================================================
  console.log('🖥️  Part 3: Remote Server Setup\n');
  console.log('   Note: fix only sets up basics. Deploy updates configs.\n');
  
  const { setupServerBasics } = require('../utils/server-check');
  
  for (const env of environments) {
    const envName = env.name.toUpperCase();
    const sshKeyName = `${envName}_SSH`;
    
    try {
      console.log(`   📤 Checking ${env.name} server...\n`);
      
      // Check if SSH key exists in GitHub (we can't read the value for security)
      const secretsCheck = await secretStore.checkSecrets([sshKeyName]);
      
      if (secretsCheck.error) {
        console.log(`   ⚠️  Error checking secrets: ${secretsCheck.error}\n`);
        fixReport.servers[env.name].push('Error checking secrets');
        continue;
      }
      
      if (!secretsCheck.present.includes(sshKeyName)) {
        console.log(`   ⚠️  ${sshKeyName} not found in GitHub`);
        console.log(`      Run: npx factiii secrets --env ${env.name}\n`);
        fixReport.servers[env.name].push('Missing SSH key');
        continue;
      }
      
      // Get host from environment config
      const host = env.host;
      
      if (!host) {
        console.log(`   ⚠️  No host configured for ${env.name}\n`);
        fixReport.servers[env.name].push('No host configured');
        continue;
      }
      
      // Note: We can't read SSH keys from GitHub Secrets for security reasons
      // Server setup will happen during first deployment via GitHub Actions
      console.log(`   ✅ ${env.name} configuration valid`);
      console.log(`      Server setup will occur during deployment\n`);
      fixReport.servers[env.name].push('Ready for deployment');
      
    } catch (error) {
      console.log(`   ⚠️  Error checking ${env.name} server: ${error.message}`);
      console.log(`      Will be set up during deployment\n`);
      fixReport.servers[env.name].push('Ready for deployment');
    }
  }
  
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

  // Config Migration
  if (fixReport.configMigration) {
    console.log('   Configuration Migration:');
    console.log(`      ✅ ${fixReport.configMigration}`);
    console.log('');
  }

  // Config Sync Fixes
  if (fixReport.configSync) {
    console.log('   Configuration Sync:');
    console.log(`      ✅ ${fixReport.configSync}`);
    console.log('');
  }

  // DNS Hostname Fixes
  if (Object.keys(fixReport.dns).length > 0) {
    console.log('   DNS Hostnames:');
    for (const [env, status] of Object.entries(fixReport.dns)) {
      if (status.startsWith('Fixed:')) {
        console.log(`      ✅ ${env}: ${status}`);
      } else {
        console.log(`      ✅ ${env}: ${status}`);
      }
    }
    console.log('');
  }

  if (fixReport.github.length > 0) {
    console.log('   GitHub Secrets:');
    fixReport.github.forEach(fix => console.log(`      ✅ ${fix}`));
    console.log('');
  }
  
  if (Object.keys(fixReport.servers).length > 0) {
    console.log('   Server Environments:');
    for (const [env, fixes] of Object.entries(fixReport.servers)) {
      fixes.forEach(fix => console.log(`      ✅ ${env}: ${fix}`));
    }
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
  
  // Show final status
  if (fixReport.errors.length === 0) {
    console.log('✅ All issues fixed!\n');
    console.log('   Next: npx factiii deploy\n');
  } else {
    console.log('⚠️  Some issues could not be fixed automatically:\n');
    fixReport.errors.forEach(err => console.log(`   - ${err}`));
    console.log('\n   Fix manually, then run: npx factiii fix\n');
  }
}

module.exports = fix;
