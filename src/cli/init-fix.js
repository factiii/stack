const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const init = require('./init');
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
 * Main init fix function - fixes all environments including uploading secrets
 */
async function initFix(options = {}) {
  const rootDir = process.cwd();
  const configPath = path.join(rootDir, 'factiii.yml');
  
  console.log('═'.repeat(70));
  console.log('🔧 INIT FIX: Automated Environment Setup');
  console.log('═'.repeat(70));
  console.log('');
  
  // Track what we fix
  const fixReport = {
    local: [],
    github: [],
    servers: {},
    errors: []
  };
  
  // ============================================================
  // STAGE 1: CHECK EVERYTHING FIRST
  // ============================================================
  console.log('📋 Stage 1: Discovering Issues\n');
  console.log('   Running comprehensive check...\n');
  
  // Run init check to discover all issues
  const initSummary = await init({ ...options, noRemote: true, skipWorkflow: true });
  
  console.log('\n' + '─'.repeat(70));
  console.log('');
  
  // Check if init found critical issues - if so, exit before attempting fixes
  if (initSummary && initSummary.critical > 0) {
    console.error('❌ Init found critical issues that must be fixed manually.');
    console.error('   Please address the issues shown above before running init fix.');
    process.exit(1);
  }
  
  // Check if we have a config
  if (!fs.existsSync(configPath)) {
    console.error('❌ factiii.yml not found. Run: npx factiii init');
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
    console.error('   Or pass temporarily: npx factiii init fix --token <token>');
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
  // STAGE 2A: LOCAL ENVIRONMENT (already fixed by init above)
  // ============================================================
  console.log('📦 Part 1: Local Environment');
  console.log('   ✅ Configs generated (done by init check)');
  console.log('   ✅ Dependencies validated');
  console.log('   ✅ All local files ready\n');
  fixReport.local.push('Local environment configured');
  
  // ============================================================
  // STAGE 2B: PARSE ENVIRONMENTS AND COLLECT SECRETS
  // ============================================================
  const environments = parseEnvironments(config);
  
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
  
  // Copy factiii.yml and factiiiAuto.yml to servers
  for (const env of environments) {
    const envName = env.name.toUpperCase();
    const sshKeyName = `${envName}_SSH`;
    const hostKey = `${envName}_HOST`;
    const userKey = `${envName}_USER`;
    
    try {
      console.log(`   📤 Uploading config to ${env.name} server...`);
      
      // Get SSH credentials from secret store
      const sshCredentials = await secretStore.getSecrets([sshKeyName]);
      
      if (!sshCredentials[sshKeyName]) {
        console.log(`   ⚠️  ${sshKeyName} not found in GitHub, skipping server setup`);
        console.log(`      Config will be uploaded during first deployment\n`);
        fixReport.servers[env.name].push('Ready for deployment');
        continue;
      }
      
      // Get host and user from factiii.yml
      const host = env.config.host;
      const user = env.config.ssh_user || 'ubuntu';
      
      if (!host) {
        console.log(`   ⚠️  No host configured for ${env.name}, skipping server setup\n`);
        fixReport.servers[env.name].push('Ready for deployment (no host configured)');
        continue;
      }
      
      // Write SSH key to temporary file
      const { execSync } = require('child_process');
      const os = require('os');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-'));
      const keyPath = path.join(tmpDir, 'deploy_key');
      
      fs.writeFileSync(keyPath, sshCredentials[sshKeyName], { mode: 0o600 });
      
      // Create infrastructure directory on server
      try {
        execSync(
          `ssh -i "${keyPath}" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "${user}@${host}" "mkdir -p ~/.factiii/configs"`,
          { stdio: 'pipe' }
        );
        
        // Copy factiii.yml to server as {repo_name}.yml
        const repoConfigName = `${config.name}.yml`;
        execSync(
          `scp -i "${keyPath}" -o StrictHostKeyChecking=no "${configPath}" "${user}@${host}:~/.factiii/configs/${repoConfigName}"`,
          { stdio: 'pipe' }
        );
        
        console.log(`   ✅ Config uploaded to ${env.name} server\n`);
        fixReport.servers[env.name].push('Config uploaded');
      } catch (sshError) {
        console.log(`   ⚠️  Could not upload to ${env.name} server: ${sshError.message}`);
        console.log(`      Config will be uploaded during deployment\n`);
        fixReport.servers[env.name].push('Ready for deployment');
      } finally {
        // Clean up temp directory
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (e) {
          // Ignore cleanup errors
        }
      }
      
    } catch (error) {
      console.log(`   ⚠️  Error setting up ${env.name} server: ${error.message}`);
      console.log(`      Config will be uploaded during deployment\n`);
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
  
  // Ask about deployment only if there are no errors
  if (fixReport.errors.length === 0 && !options.noRemote) {
    const shouldDeploy = await confirm('🚀 Deploy now?', true);
    
    if (shouldDeploy) {
      console.log('\n📦 Running deployment...\n');
      
      try {
        const deploy = require('./deploy');
        await deploy({ token });
      } catch (error) {
        console.error(`❌ Deployment failed: ${error.message}`);
        fixReport.errors.push(`Deployment: ${error.message}`);
      }
    } else {
      console.log('\n💡 Run deployment later with: npx factiii deploy\n');
    }
  } else if (fixReport.errors.length > 0) {
    console.log('\n⚠️  Deployment skipped due to errors above.');
    console.log('   Fix the errors and run: npx factiii init fix\n');
  }
  
  // Optionally trigger workflow to verify
  if (!options.noRemote && token && fixReport.errors.length === 0) {
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
          workflow_id: 'factiii-init.yml'
        });
        console.log(`✅ Found workflow: ${workflow.name}\n`);
      } catch (error) {
        if (error.status === 404) {
          console.log('⚠️  Workflow not found in GitHub repository.');
          console.log('   Please commit and push .github/workflows/factiii-init.yml');
          console.log('   Then run: npx factiii init (to verify)\n');
          return;
        }
        throw error;
      }
      
      // Trigger workflow with fix=true to verify
      await octokit.rest.actions.createWorkflowDispatch({
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        workflow_id: 'factiii-init.yml',
        ref: currentBranch,
        inputs: {
          fix: 'true'
        }
      });
      
      console.log(`✅ Workflow triggered on branch: ${currentBranch}`);
      console.log(`   Repository: ${repoInfo.owner}/${repoInfo.repo}`);
      console.log(`   View: https://github.com/${repoInfo.owner}/${repoInfo.repo}/actions\n`);
    } catch (error) {
      if (error.status === 404) {
        console.log('⚠️  Workflow not found in GitHub.');
        console.log('   Please commit and push .github/workflows/factiii-init.yml\n');
      } else {
        console.log(`⚠️  Could not trigger workflow: ${error.message}`);
        console.log('   Run: npx factiii init (to verify manually)\n');
      }
    }
  } else {
    console.log('   Run: npx factiii init (to verify)\n');
  }
}

module.exports = initFix;
