const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { execSync } = require('child_process');
const generateWorkflows = require('./generate-workflows');

/**
 * Check factiii.yml status and detect if it needs customization
 */
function checkCoreYmlStatus(rootDir, templatePath) {
  const configPath = path.join(rootDir, 'factiii.yml');
  const result = {
    exists: false,
    needsCustomization: false,
    placeholders: [],
    config: null,
    path: configPath
  };

  if (!fs.existsSync(configPath)) {
    return result;
  }

  result.exists = true;

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const config = yaml.load(content);
    result.config = config;

    // Check for common placeholder values
    if (config.name === 'your-repo-name') {
      result.needsCustomization = true;
      result.placeholders.push({ field: 'name', value: 'your-repo-name' });
    }

    if (config.environments) {
      for (const [env, envConfig] of Object.entries(config.environments)) {
        if (envConfig.domain && envConfig.domain.includes('yourdomain.com')) {
          result.needsCustomization = true;
          result.placeholders.push({ field: `environments.${env}.domain`, value: envConfig.domain });
        }
      }
    }

    if (config.ssl_email && config.ssl_email.includes('yourdomain.com')) {
      result.needsCustomization = true;
      result.placeholders.push({ field: 'ssl_email', value: config.ssl_email });
    }

    if (config.ecr_registry && config.ecr_registry.includes('123456789')) {
      result.needsCustomization = true;
      result.placeholders.push({ field: 'ecr_registry', value: config.ecr_registry });
    }

  } catch (e) {
    result.parseError = e.message;
  }

  return result;
}

/**
 * Check GitHub workflows status
 * Note: Factiii GENERATES these for repos but does NOT use them itself
 * These are repo CI/CD workflows that run independently on git events
 */
function checkWorkflowsStatus(rootDir) {
  const workflowsDir = path.join(rootDir, '.github', 'workflows');
  const result = {
    stagingExists: false,
    productionExists: false,
    undeployExists: false,
    anyExist: false
  };

  const stagingPath = path.join(workflowsDir, 'factiii-staging.yml');
  const productionPath = path.join(workflowsDir, 'factiii-production.yml');
  const undeployPath = path.join(workflowsDir, 'factiii-undeploy.yml');

  result.stagingExists = fs.existsSync(stagingPath);
  result.productionExists = fs.existsSync(productionPath);
  result.undeployExists = fs.existsSync(undeployPath);
  result.anyExist = result.stagingExists || result.productionExists || result.undeployExists;

  return result;
}

/**
 * Check git branch structure
 */
function checkBranchStatus(rootDir) {
  const result = {
    hasGit: false,
    hasStagingBranch: false,
    hasProductionBranch: false,
    currentBranch: null,
    error: null
  };

  try {
    // Check if .git directory exists
    if (!fs.existsSync(path.join(rootDir, '.git'))) {
      return result;
    }

    result.hasGit = true;

    // Get current branch
    try {
      result.currentBranch = execSync('git branch --show-current', { 
        encoding: 'utf8', 
        stdio: 'pipe',
        cwd: rootDir 
      }).trim();
    } catch (e) {
      // Ignore
    }

    // Check for staging branch (or main as alternative)
    try {
      execSync('git rev-parse --verify staging', { 
        stdio: 'pipe',
        cwd: rootDir 
      });
      result.hasStagingBranch = true;
    } catch (e) {
      // If staging doesn't exist, check if main exists (can be used for staging)
      try {
        execSync('git rev-parse --verify main', { 
          stdio: 'pipe',
          cwd: rootDir 
        });
        result.hasStagingBranch = true; // main can serve as staging
        result.usesMainForStaging = true;
      } catch (e2) {
        // Neither exists
      }
    }

    // Check for production branch (also check 'prod' as alias)
    try {
      execSync('git rev-parse --verify production', { 
        stdio: 'pipe',
        cwd: rootDir 
      });
      result.hasProductionBranch = true;
    } catch (e) {
      // Try 'prod' as well
      try {
        execSync('git rev-parse --verify prod', { 
          stdio: 'pipe',
          cwd: rootDir 
        });
        result.hasProductionBranch = true;
      } catch (e2) {
        // Neither exists
      }
    }

  } catch (e) {
    result.error = e.message;
  }

  return result;
}

/**
 * Search for Prisma schema file recursively
 */
function findPrismaSchema(rootDir) {
  // Common locations to check (in priority order)
  const commonPaths = [
    'prisma/schema.prisma',
    'apps/server/prisma/schema.prisma',
    'packages/server/prisma/schema.prisma',
    'backend/prisma/schema.prisma',
    'server/prisma/schema.prisma'
  ];
  
  // Check common paths first
  for (const relativePath of commonPaths) {
    if (fs.existsSync(path.join(rootDir, relativePath))) {
      return relativePath;
    }
  }
  
  // Fallback: recursive search (max depth 5)
  try {
    const result = execSync(
      'find . -name "schema.prisma" -path "*/prisma/*" -maxdepth 5 ' +
      '-not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null || true',
      { encoding: 'utf8', cwd: rootDir, stdio: 'pipe' }
    ).trim();
    
    if (result) {
      const firstMatch = result.split('\n')[0];
      return firstMatch.replace(/^\.\//, ''); // Remove leading ./
    }
  } catch (e) {
    // Ignore search errors
  }
  
  return null;
}

/**
 * Detect Prisma version from package.json
 * Checks root package.json and workspace packages (for monorepos)
 */
function detectPrismaVersion(rootDir, schemaPath = null) {
  // Helper function to extract version from package.json
  const extractVersion = (pkgPath) => {
    if (!fs.existsSync(pkgPath)) {
      return null;
    }
    
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const allDeps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {})
      };
      
      const version = allDeps.prisma || allDeps['@prisma/client'];
      if (version) {
        return version.replace(/^[\^~]/, '');
      }
    } catch (e) {
      // Ignore errors
    }
    return null;
  };
  
  // First, check root package.json
  const rootPkgPath = path.join(rootDir, 'package.json');
  let version = extractVersion(rootPkgPath);
  if (version) {
    return version;
  }
  
  // If schema path is provided, check package.json in the same workspace
  if (schemaPath) {
    // Get the directory containing the schema (e.g., apps/server/prisma -> apps/server)
    const schemaDir = path.dirname(path.join(rootDir, schemaPath));
    const workspaceDir = path.dirname(schemaDir); // Go up one level from prisma folder
    const workspacePkgPath = path.join(workspaceDir, 'package.json');
    
    version = extractVersion(workspacePkgPath);
    if (version) {
      return version;
    }
  }
  
  // Fallback: search common workspace locations
  const workspacePaths = [
    'apps/server/package.json',
    'packages/server/package.json',
    'backend/package.json',
    'server/package.json'
  ];
  
  for (const wsPath of workspacePaths) {
    version = extractVersion(path.join(rootDir, wsPath));
    if (version) {
      return version;
    }
  }
  
  return null;
}

/**
 * Validate GitHub secrets exist (no local comparison - GitHub is source of truth)
 * 
 * Required secrets (minimal):
 * - {ENV}_SSH: SSH private key for each environment
 * - AWS_SECRET_ACCESS_KEY: AWS secret (only truly secret AWS value)
 * 
 * Not secrets (in factiii.yml):
 * - HOST: in environments.{env}.host
 * - AWS_ACCESS_KEY_ID: in aws.access_key_id
 * - AWS_REGION: in aws.region
 * 
 * Not secrets (in factiiiAuto.yml):
 * - USER: defaults to ubuntu
 */
async function validateGitHubSecrets(config) {
  const { GitHubSecretsStore } = require('../utils/github-secrets');
  const environments = Object.keys(config.environments || {});
  const results = {
    missing: [],
    present: [],
    error: null,
    tokenAvailable: false
  };

  // Check if GITHUB_TOKEN is available
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    results.error = 'GITHUB_TOKEN not set';
    return results;
  }

  results.tokenAvailable = true;

  // Build list of required secrets (minimal - only truly secret values)
  const requiredSecrets = [];
  for (const env of environments) {
    const prefix = env.toUpperCase();
    requiredSecrets.push(`${prefix}_SSH`);  // SSH private key only
  }
  
  // Only AWS_SECRET_ACCESS_KEY needs to be a secret
  requiredSecrets.push('AWS_SECRET_ACCESS_KEY');

  // Use GitHub API to check which secrets exist
  try {
    const secretStore = new GitHubSecretsStore(token);
    const check = await secretStore.checkSecrets(requiredSecrets);
    
    if (check.error) {
      results.error = check.error;
      return results;
    }

    results.present = check.present || [];
    results.missing = check.missing || [];

  } catch (error) {
    results.error = error.message;
  }

  return results;
}

/**
 * Validate repository scripts and Prisma configuration
 */
function validateRepoScripts(rootDir) {
  const packageJsonPath = path.join(rootDir, 'package.json');
  const results = {
    hasPackageJson: false,
    requiredScripts: {
      'test:server': false
    },
    optionalScripts: {
      'db:backup': false,
      'db:restore': false,
      'test:integration': false,
      'test:client': false,
      'test:mobile': false
    },
    hasPrisma: false,
    hasPrismaSchema: false,
    prismaSchemaPath: null,
    prismaVersion: null,
    packageJson: null
  };

  // Check if package.json exists
  if (!fs.existsSync(packageJsonPath)) {
    return results;
  }

  results.hasPackageJson = true;

  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    results.packageJson = pkg;

    // Check for required scripts
    const scripts = pkg.scripts || {};
    results.requiredScripts['test:server'] = !!scripts['test:server'];

    // Check for optional scripts
    results.optionalScripts['db:backup'] = !!scripts['db:backup'];
    results.optionalScripts['db:restore'] = !!scripts['db:restore'];
    results.optionalScripts['test:integration'] = !!scripts['test:integration'];
    results.optionalScripts['test:client'] = !!scripts['test:client'];
    results.optionalScripts['test:mobile'] = !!scripts['test:mobile'];

    // Check for Prisma in root package.json
    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {})
    };
    results.hasPrisma = !!(allDeps.prisma || allDeps['@prisma/client']);

    // Auto-detect Prisma schema location
    const schemaPath = findPrismaSchema(rootDir);
    if (schemaPath) {
      results.hasPrismaSchema = true;
      results.prismaSchemaPath = schemaPath;
    }

    // Auto-detect Prisma version (pass schema path for monorepo support)
    results.prismaVersion = detectPrismaVersion(rootDir, schemaPath);
    
    // If we found a schema or version, Prisma is installed (even if not in root)
    if (schemaPath || results.prismaVersion) {
      results.hasPrisma = true;
    }

  } catch (e) {
    // Ignore JSON parse errors
  }

  return results;
}

/**
 * Display comprehensive audit report
 */
function displayAuditReport(auditResults) {
  const { coreYml, workflows, repoScripts, branches, envFiles, servers } = auditResults;

  console.log('🚀 Running infrastructure audit...\n');
  console.log('=' .repeat(60));

  // 1. Configuration Status
  console.log('\n📋 Configuration Status:');
  if (!coreYml.exists) {
    console.log('   ❌ factiii.yml does not exist');
    console.log('      Will create on first run or with --force flag');
  } else if (coreYml.parseError) {
    console.log('   ❌ factiii.yml has parsing errors');
    console.log(`      Error: ${coreYml.parseError}`);
  } else if (coreYml.needsCustomization) {
    console.log('   ⚠️  factiii.yml exists but needs customization');
    console.log('      Placeholder values detected:');
    for (const placeholder of coreYml.placeholders) {
      console.log(`         - ${placeholder.field}: ${placeholder.value}`);
    }
    console.log('      💡 Edit factiii.yml with your actual values');
  } else {
    console.log('   ✅ factiii.yml exists and is customized');
  }

  // 1b. Config Version Status
  if (auditResults.configOutdated) {
    console.log('\n📋 Configuration Version:');
    if (!auditResults.configOutdated.hasVersion) {
      console.log(`   ⚠️  factiii.yml is pre-${auditResults.configOutdated.latestVersion} format (no version tracking)`);
      console.log('      Run: npx factiii fix (will add version tracking)');
    } else {
      console.log(`   ⚠️  factiii.yml is outdated: ${auditResults.configOutdated.currentVersion} → ${auditResults.configOutdated.latestVersion}`);
      console.log('      Run: npx factiii fix (will migrate to latest)');
      if (auditResults.configOutdated.migrations && auditResults.configOutdated.migrations.length > 0) {
        console.log(`      Migrations needed: ${auditResults.configOutdated.migrations.join(', ')}`);
      }
    }
  }

  // 1c. Schema Validation
  if (auditResults.configSchema) {
    if (auditResults.configSchema.missing && auditResults.configSchema.missing.length > 0) {
      console.log('\n📋 Configuration Schema:');
      console.log('   ❌ Missing required fields:');
      auditResults.configSchema.missing.forEach(f => console.log(`      - ${f}`));
      console.log('      Run: npx factiii fix');
    }
    
    if (auditResults.configSchema.newOptional && auditResults.configSchema.newOptional.length > 0) {
      console.log('\n💡 New Optional Fields Available:');
      auditResults.configSchema.newOptional.forEach(f => {
        console.log(`   - ${f.path}`);
        console.log(`     ${f.description}`);
      });
      console.log('   💡 These fields are optional - add them to factiii.yml if needed');
    }
  }

  // 2. GitHub Workflows (Generated for Repo CI/CD)
  console.log('\n📝 GitHub Workflows (Repo CI/CD):');
  console.log('   ℹ️  Factiii generates these for your repo - they run independently');
  if (workflows.stagingExists) {
    console.log('   ✅ factiii-staging.yml exists (auto-deploy on push to main)');
  } else {
    console.log('   ⚠️  factiii-staging.yml missing');
  }
  if (workflows.productionExists) {
    console.log('   ✅ factiii-production.yml exists (auto-deploy on merge to production)');
  } else {
    console.log('   ⚠️  factiii-production.yml missing');
  }
  if (workflows.undeployExists) {
    console.log('   ✅ factiii-undeploy.yml exists (manual cleanup)');
  } else {
    console.log('   ⚠️  factiii-undeploy.yml missing (optional)');
  }
  if (!workflows.anyExist) {
    console.log('      💡 Generate: npx factiii generate-workflows');
  }

  // 3. Repository Scripts
  console.log('\n📦 Required Scripts in package.json:');
  if (!repoScripts.hasPackageJson) {
    console.log('   ⚠️  No package.json found');
    console.log('      This repository may not be a Node.js project');
  } else {
    const requiredAll = Object.entries(repoScripts.requiredScripts).every(([_, exists]) => exists);
    
    for (const [script, exists] of Object.entries(repoScripts.requiredScripts)) {
      if (exists) {
        console.log(`   ✅ ${script}`);
      } else {
        console.log(`   ❌ ${script} - MISSING`);
      }
    }

    if (!requiredAll) {
      console.log('\n   💡 Add missing scripts to package.json:');
      console.log('      {');
      console.log('        "scripts": {');
      if (!repoScripts.requiredScripts['test:server']) {
        console.log('          "test:server": "turbo run test --filter=your-server"  // Server tests');
      }
      console.log('        }');
      console.log('      }');
      console.log('      Note: Docker builds happen in workflows using your Dockerfile');
    }

    // Optional scripts
    const hasOptional = Object.values(repoScripts.optionalScripts).some(v => v);
    if (hasOptional) {
      console.log('\n📦 Optional Scripts (detected):');
      for (const [script, exists] of Object.entries(repoScripts.optionalScripts)) {
        if (exists) {
          console.log(`   ✅ ${script}`);
        }
      }
    }
  }

  // 4. Prisma Configuration
  console.log('\n🔷 Prisma Configuration:');
  if (repoScripts.hasPrisma) {
    console.log('   ✅ Prisma installed');
    
    // Show version if detected
    if (repoScripts.prismaVersion) {
      console.log(`   📦 Version: ${repoScripts.prismaVersion}`);
    }
    
    // Show schema location
    if (repoScripts.hasPrismaSchema) {
      console.log(`   ✅ Schema: ${repoScripts.prismaSchemaPath}`);
      
      // Check if factiii.yml has it configured
      if (coreYml.config?.prisma_schema) {
        if (coreYml.config.prisma_schema === repoScripts.prismaSchemaPath) {
          console.log('   ✅ factiii.yml prisma_schema matches detected location');
        } else {
          console.log('   ⚠️  factiii.yml prisma_schema differs from detected:');
          console.log(`      Config: ${coreYml.config.prisma_schema}`);
          console.log(`      Found:  ${repoScripts.prismaSchemaPath}`);
          console.log('      💡 Run: npx factiii --force to update');
        }
      }
      
      // Check version match
      if (coreYml.config?.prisma_version && repoScripts.prismaVersion) {
        if (coreYml.config.prisma_version !== repoScripts.prismaVersion) {
          console.log('   ⚠️  Version mismatch:');
          console.log(`      factiii.yml: ${coreYml.config.prisma_version}`);
          console.log(`      package.json: ${repoScripts.prismaVersion}`);
          console.log('      💡 Run: npx factiii --force to update');
        }
      }
    } else {
      console.log('   ⚠️  schema.prisma not found');
      console.log('      💡 Run: npx prisma init');
    }
    
    if (!repoScripts.optionalScripts['db:backup']) {
      console.log('\n   💡 Recommended: Add database backup script:');
      console.log('      "db:backup": "pg_dump $DATABASE_URL > backup.sql"');
    }
  } else {
    console.log('   ⚠️  Prisma not installed');
    console.log('      Production workflow assumes Prisma for migrations');
    console.log('      💡 Install: npm install -D prisma @prisma/client');
  }

  // 5. Environment Files
  console.log('\n📄 Environment Files:');
  if (envFiles) {
    if (envFiles.devExists) {
      const keyCount = Object.keys(envFiles.dev).length;
      console.log(`   ✅ .env.example exists (${keyCount} keys defined)`);
    } else {
      console.log('   ❌ .env.example missing (required as template)');
    }
    
    if (envFiles.stagingExists) {
      const keyCount = Object.keys(envFiles.staging).length;
      console.log(`   ✅ .env.staging exists (${keyCount} keys)`);
      if (envFiles.stagingGitignored) {
        console.log('      Gitignored: ✅ Yes');
      } else {
        const isStagingSecret = coreYml.config?.auto?.isStagingSecret !== false; // default true
        if (isStagingSecret) {
          console.log('      Gitignored: ⚠️  No (recommended for secrets)');
        } else {
          console.log('      Gitignored: ✅ No (OK, not secret)');
        }
      }
    } else {
      console.log('   ❌ .env.staging missing');
    }
    
    if (envFiles.prodLocal) {
      const keyCount = Object.keys(envFiles.prod).length;
      console.log(`   ✅ .env.prod exists locally (${keyCount} keys)`);
      if (envFiles.prodGitignored) {
        console.log('      Gitignored: ✅ Yes (required)');
      } else {
        console.log('      Gitignored: ❌ MUST BE GITIGNORED');
      }
      
      if (envFiles.prodDifferences) {
        console.log('      ⚠️  Differs from GitHub PROD_ENVS');
        if (envFiles.prodDifferences.changed.length > 0) {
          console.log(`         Changed: ${envFiles.prodDifferences.changed.join(', ')}`);
        }
        if (envFiles.prodDifferences.onlyLocal.length > 0) {
          console.log(`         Only local: ${envFiles.prodDifferences.onlyLocal.join(', ')}`);
        }
        if (envFiles.prodDifferences.onlyGitHub.length > 0) {
          console.log(`         Only GitHub: ${envFiles.prodDifferences.onlyGitHub.join(', ')}`);
        }
        console.log('         💡 Deploy will overwrite GitHub with local values');
      }
    } else if (envFiles.prodGitHub) {
      console.log('   ℹ️  .env.prod in GitHub Secrets (not local - OK for security)');
    } else {
      console.log('   ❌ .env.prod not found (locally or in GitHub)');
    }
    
    if (envFiles.warnings.length > 0) {
      console.log('\n   ⚠️  Warnings:');
      for (const warning of envFiles.warnings) {
        console.log(`      - ${warning}`);
      }
    }
    
    if (envFiles.errors.length > 0) {
      console.log('\n   ❌ Errors:');
      for (const error of envFiles.errors) {
        console.log(`      - ${error}`);
      }
    }
  }

  // 6. GitHub Secrets
  console.log('\n🔑 GitHub Secrets:');
  
  if (!auditResults.githubSecrets) {
    console.log('   ℹ️  Required secrets (minimal):');
    console.log('      - STAGING_SSH, PROD_SSH (SSH private keys)');
    console.log('      - AWS_SECRET_ACCESS_KEY (AWS secret key)');
    console.log('');
    console.log('   ℹ️  Optional secrets:');
    console.log('      - STAGING_ENVS, PROD_ENVS (environment variables)');
    console.log('');
    console.log('   ℹ️  Not secrets (in factiii.yml):');
    console.log('      - HOST: environments.{env}.host');
    console.log('      - AWS_ACCESS_KEY_ID: aws.access_key_id');
    console.log('      - AWS_REGION: aws.region');
  } else if (auditResults.githubSecrets.error) {
    if (auditResults.githubSecrets.error === 'GITHUB_TOKEN not set') {
      console.log('   ⚠️  GITHUB_TOKEN not set - cannot validate secrets');
      console.log('');
      console.log('   💡 Set GITHUB_TOKEN to check secrets:');
      console.log('      export GITHUB_TOKEN=ghp_your_token_here');
      console.log('');
      console.log('   ℹ️  Required secrets (minimal):');
      console.log('      - STAGING_SSH, PROD_SSH (SSH private keys)');
      console.log('      - AWS_SECRET_ACCESS_KEY (AWS secret key)');
    } else {
      console.log(`   ⚠️  Error checking secrets: ${auditResults.githubSecrets.error}`);
    }
  } else {
    // Show validation results
    const { missing, present } = auditResults.githubSecrets;
    
    if (missing.length === 0) {
      console.log('   ✅ All required secrets exist in GitHub');
      if (present.length > 0) {
        console.log(`   📋 Found ${present.length} secret(s):`);
        present.forEach(name => console.log(`      - ${name}`));
      }
    } else {
      if (missing.length > 0) {
        console.log('   ❌ Missing required secrets in GitHub:');
        missing.forEach(name => console.log(`      - ${name}`));
      }
      
      if (present.length > 0) {
        console.log(`   ✅ ${present.length} secret(s) exist in GitHub`);
      }
    }
  }
  
  console.log('');
  console.log('   💡 Manage secrets:');
  console.log('      npx factiii fix          # Setup missing secrets interactively');
  console.log('      npx factiii secrets      # Update specific secrets');
  console.log('');
  console.log('   Or manually: Repository Settings → Secrets → Actions');

  // 7. Branch Structure
  console.log('\n🌿 Branch Structure:');
  if (!branches.hasGit) {
    console.log('   ⚠️  Not a git repository');
    console.log('      💡 Initialize: git init');
  } else {
    if (branches.currentBranch) {
      console.log(`   📍 Current branch: ${branches.currentBranch}`);
    }
    
    if (branches.hasStagingBranch) {
      if (branches.usesMainForStaging) {
        console.log('   ✅ staging: using main branch');
      } else {
        console.log('   ✅ staging branch exists');
      }
    } else {
      console.log('   ⚠️  staging branch not found');
      console.log('      💡 Create: git checkout -b staging');
      console.log('      💡 Or use main branch for staging deployments');
    }
    
    if (branches.hasProductionBranch) {
      console.log('   ✅ production branch exists');
    } else {
      console.log('   ⚠️  production branch not found');
      console.log('      💡 Create: git checkout -b production');
    }
  }

  // 8. Server Status & Config Validation
  if (auditResults.servers && Object.keys(auditResults.servers).length > 0) {
    console.log('\n🖥️  Server Status & Config Validation:');
    
    for (const [env, check] of Object.entries(auditResults.servers)) {
      console.log(`\n   ${env}:`);
      
      // Basic connectivity
      if (!check.ssh) {
        console.log('      ❌ Cannot connect via SSH');
        if (check.error) {
          console.log(`         Error: ${check.error}`);
        }
        console.log('         💡 Run: npx factiii fix');
        continue;
      }
      console.log('      ✅ SSH connection');
      
      // Software checks
      if (check.git) {
        console.log('      ✅ Git installed');
      } else {
        console.log('      ❌ Git not found');
        console.log('         💡 Run: npx factiii fix');
      }
      
      if (check.docker) {
        console.log('      ✅ Docker installed');
      } else {
        console.log('      ❌ Docker not found');
        console.log('         💡 Install Docker manually');
      }
      
      // Repo status
      if (check.repo) {
        console.log(`      ✅ Repo cloned at: ~/.factiii/${check.repoName}`);
        if (check.branch) {
          console.log(`         Branch: ${check.branch}`);
        }
      } else {
        console.log(`      ⚠️  Repo not cloned yet`);
        console.log('         💡 Will be cloned on first deploy');
      }
      
      // Config validation
      if (check.configValidation) {
        const val = check.configValidation;
        
        if (val.expectedServices !== undefined && val.actualServices !== undefined) {
          if (val.expectedServices === val.actualServices) {
            console.log(`      ✅ Services match (${val.actualServices} deployed)`);
          } else {
            console.log(`      ❌ Service mismatch:`);
            console.log(`         Expected: ${val.expectedServices} services`);
            console.log(`         Deployed: ${val.actualServices} services`);
            console.log('         💡 Run: npx factiii deploy to sync');
          }
        }
        
        if (val.dockerComposeUpToDate !== null) {
          if (val.dockerComposeUpToDate) {
            console.log(`      ✅ docker-compose.yml exists`);
          } else {
            console.log(`      ⚠️  docker-compose.yml needs regeneration`);
            console.log('         💡 Run: npx factiii deploy');
          }
        }
        
        if (val.nginxMatches !== null) {
          if (val.nginxMatches) {
            console.log(`      ✅ nginx.conf exists`);
          } else {
            console.log(`      ⚠️  nginx.conf needs regeneration`);
            console.log('         💡 Run: npx factiii deploy');
          }
        }
      } else if (check.repo) {
        console.log('      ⚠️  Deployed configs not validated (run deploy first)');
      }
    }
  } else if (auditResults.githubSecrets && auditResults.githubSecrets.tokenAvailable) {
    console.log('\n🖥️  Server Status:');
    console.log('   ℹ️  Cannot check servers (SSH keys not in GitHub yet)');
    console.log('      💡 Run: npx factiii fix to set up SSH keys');
  }

  // Config Sync Validation
  if (auditResults.configSync) {
    console.log('\n⚙️  Configuration Sync:');
    
    if (auditResults.configSync.valid) {
      console.log('   ✅ factiii.yml matches generated workflows');
    } else if (auditResults.configSync.needsGeneration) {
      console.log('   ⚠️  Workflows not generated yet');
      console.log('      💡 Run: npx factiii (will generate)');
    } else if (auditResults.configSync.needsRegeneration) {
      console.log('   ❌ Configuration drift detected');
      if (auditResults.configSync.message) {
        console.log(`      ${auditResults.configSync.message}`);
      }
      if (auditResults.configSync.mismatches) {
        for (const mismatch of auditResults.configSync.mismatches) {
          console.log(`      - ${mismatch}`);
        }
      }
      console.log('      💡 Run: npx factiii fix (will regenerate workflows)');
    } else if (auditResults.configSync.error) {
      console.log(`   ⚠️  ${auditResults.configSync.error}`);
    }
  }

  // DNS Hostname Validation
  if (auditResults.dnsValidation && Object.keys(auditResults.dnsValidation).length > 0) {
    console.log('\n🌐 DNS Hostname Validation:');
    
    for (const [env, validation] of Object.entries(auditResults.dnsValidation)) {
      console.log(`\n   ${env}:`);
      console.log(`      Hostname: ${validation.hostname}`);
      
      if (validation.resolvable) {
        console.log('      ✅ DNS resolves correctly');
      } else {
        console.log('      ❌ Hostname does not resolve');
        
        if (validation.alternative) {
          console.log(`      💡 Found alternative: ${validation.alternative}`);
          console.log('         Run: npx factiii fix (will auto-correct)');
        } else {
          console.log('      💡 Check your DNS records or update factiii.yml manually');
        }
      }
    }
  }

  // 9. Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 Summary:');
  
  let passed = 0;
  let warnings = 0;
  let critical = 0;

  // Count checks
  if (coreYml.exists && !coreYml.parseError) {
    if (coreYml.needsCustomization) {
      warnings++;
    } else {
      passed++;
    }
  } else {
    critical++;
  }

  // Workflows are optional - just informational
  if (workflows.anyExist) {
    passed++;
  } else {
    // No workflows is fine - Factiii deploys directly via SSH
    // Just a note, not a warning
  }

  const requiredScriptsAll = repoScripts.hasPackageJson && 
    Object.values(repoScripts.requiredScripts).every(v => v);
  if (requiredScriptsAll) {
    passed++;
  } else {
    critical++;
  }

  if (repoScripts.hasPrisma && repoScripts.hasPrismaSchema) {
    passed++;
  } else if (repoScripts.hasPrisma) {
    warnings++;
  } else {
    warnings++;
  }

  if (branches.hasGit && branches.hasStagingBranch && branches.hasProductionBranch) {
    passed++;
  } else if (branches.hasGit) {
    warnings++;
  } else {
    warnings++;
  }
  
  // Environment files check
  if (envFiles) {
    if (envFiles.errors.length > 0) {
      critical += envFiles.errors.length;
    } else if (envFiles.devExists && envFiles.stagingExists && envFiles.prodExists) {
      passed++;
      if (envFiles.warnings.length > 0) {
        warnings += envFiles.warnings.length;
      }
    } else {
      warnings++;
    }
  }

  // GitHub secrets check
  if (auditResults.githubSecrets) {
    if (auditResults.githubSecrets.error) {
      // Token not available or API error - warning
      warnings++;
    } else if (auditResults.githubSecrets.missing.length > 0) {
      critical++; // Missing secrets are critical
    } else {
      passed++; // All secrets present
    }
  }

  // Server checks
  if (servers && Object.keys(servers).length > 0) {
    for (const [env, check] of Object.entries(servers)) {
      if (check.ssh && check.git && check.docker) {
        if (check.configValidation && 
            check.configValidation.expectedServices === check.configValidation.actualServices &&
            check.configValidation.dockerComposeUpToDate &&
            check.configValidation.nginxMatches) {
          passed++; // Server fully configured
        } else if (check.repo) {
          warnings++; // Server accessible but configs need sync
        } else {
          warnings++; // Server accessible but repo not cloned
        }
      } else if (check.ssh) {
        warnings++; // Can connect but missing software
      } else {
        // Can't connect - this is only a warning if SSH key exists
        warnings++;
      }
    }
  }

  // Config sync check
  if (auditResults.configSync) {
    if (auditResults.configSync.valid) {
      passed++;
    } else if (auditResults.configSync.needsRegeneration) {
      warnings++; // Can be auto-fixed
    } else {
      warnings++;
    }
  }

  // DNS validation check
  if (auditResults.dnsValidation) {
    for (const [env, validation] of Object.entries(auditResults.dnsValidation)) {
      if (validation.resolvable) {
        passed++;
      } else if (validation.canAutoFix) {
        warnings++; // Can be auto-fixed
      } else {
        critical++; // Needs manual intervention
      }
    }
  }

  console.log(`   ✅ ${passed} checks passed`);
  console.log(`   ⚠️  ${warnings} items need attention`);
  console.log(`   ❌ ${critical} critical issues`);

  return { passed, warnings, critical };
}

/**
 * Display conditional next steps based on audit results
 */
function displayNextSteps(auditResults) {
  const { coreYml, workflows, repoScripts, branches } = auditResults;

  console.log('\n💡 Next Steps:\n');

  const steps = [];

  // Check what needs to be done
  if (!coreYml.exists) {
    steps.push('Run this command again to create factiii.yml');
  } else if (coreYml.needsCustomization) {
    steps.push('Edit factiii.yml with your actual domains and settings');
  }

  if (!workflows.anyExist) {
    steps.push('Generate CI/CD workflows: npx factiii generate-workflows');
  }

  const missingScripts = repoScripts.hasPackageJson && 
    Object.entries(repoScripts.requiredScripts)
      .filter(([_, exists]) => !exists)
      .map(([script, _]) => script);

  if (missingScripts && missingScripts.length > 0) {
    steps.push('Add missing scripts to package.json (see suggestions above)');
  }

  if (!repoScripts.hasPrisma) {
    steps.push('Install Prisma: npm install -D prisma @prisma/client');
    steps.push('Initialize Prisma: npx prisma init');
  } else if (!repoScripts.hasPrismaSchema) {
    steps.push('Initialize Prisma: npx prisma init');
  }

  if (branches.hasGit && (!branches.hasStagingBranch || !branches.hasProductionBranch)) {
    const missing = [];
    if (!branches.hasStagingBranch) {
      // Only suggest creating staging if not using main
      if (!branches.usesMainForStaging) {
        missing.push('staging');
      }
    }
    if (!branches.hasProductionBranch) missing.push('production');
    
    if (missing.length > 0) {
      steps.push(`Create ${missing.join(' and ')} branch(es)`);
    }
  } else if (!branches.hasGit) {
    steps.push('Initialize git repository: git init');
  }

  steps.push('Set environment variables with secrets (or use GitHub Secrets if using workflows)');
  steps.push('Test deployment: npx factiii deploy');

  // Display steps
  steps.forEach((step, index) => {
    console.log(`   ${index + 1}. ${step}`);
  });

  console.log('');
}

/**
 * Main scan function - comprehensive audit tool
 */
async function scan(options = {}) {
  const rootDir = process.cwd();
  const configPath = path.join(rootDir, 'factiii.yml');
  const templatePath = path.join(__dirname, '../../templates/factiii.yml.example');

  // Always run comprehensive audit
  const auditResults = {
    coreYml: checkCoreYmlStatus(rootDir, templatePath),
    workflows: checkWorkflowsStatus(rootDir),
    repoScripts: validateRepoScripts(rootDir),
    branches: checkBranchStatus(rootDir),
    envFiles: null, // Will be added after config is loaded
    githubSecrets: null // Will be added after config is loaded
  };

  // Determine if we should create/update files
  const shouldCreateCoreYml = !auditResults.coreYml.exists || options.force;
  // Always check workflows for updates (it will detect if no changes needed)
  const shouldGenerateWorkflows = true;

  // Create factiii.yml if needed
  if (shouldCreateCoreYml) {
    // Read template
    if (!fs.existsSync(templatePath)) {
      console.error(`❌ Template not found: ${templatePath}`);
      process.exit(1);
    }

    const template = fs.readFileSync(templatePath, 'utf8');
    
    // Try to infer repo name from package.json
    let repoName = 'your-repo-name';
    try {
      const packageJsonPath = path.join(rootDir, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        if (pkg.name) {
          repoName = pkg.name.replace(/^@[^/]+\//, ''); // Remove scope if present
        }
      }
    } catch (e) {
      // Ignore errors
    }

    // Replace placeholder with actual repo name
    let config = template.replace(/EXAMPLE-factiii/g, repoName);

    // Auto-detect and append Prisma configuration if found
    if (auditResults.repoScripts.hasPrisma) {
      const schemaPath = auditResults.repoScripts.prismaSchemaPath;
      const version = auditResults.repoScripts.prismaVersion;
      
      if (schemaPath || version) {
        const prismaConfig = [];
        
        // Remove the commented examples from template
        config = config.replace(
          /# Prisma configuration \(auto-detected from your project\)[\s\S]*?# prisma_version:.*\n\n/,
          ''
        );
        
        prismaConfig.push('\n# Prisma configuration (auto-detected)');
        if (schemaPath) {
          prismaConfig.push(`prisma_schema: ${schemaPath}`);
        }
        if (version) {
          prismaConfig.push(`prisma_version: ${version}`);
        }
        
        config += prismaConfig.join('\n') + '\n';
      }
    }

    // Write config file
    fs.writeFileSync(configPath, config);
    
    // Update audit results
    auditResults.coreYml = checkCoreYmlStatus(rootDir, templatePath);
  }
  
  // Generate factiiiAuto.yml with auto-detected settings
  console.log('🔧 Auto-detecting project configuration...\n');
  try {
    const { generateCoreAuto } = require('../generators/generate-factiii-auto');
    generateCoreAuto(rootDir);
  } catch (error) {
    console.log(`⚠️  Warning: Failed to generate factiiiAuto.yml: ${error.message}\n`);
  }
  
  // Validate environment files (after config is available)
  const { validateEnvFiles } = require('../utils/env-validator');
  const loadedConfig = auditResults.coreYml.config || {};
  auditResults.envFiles = validateEnvFiles(rootDir, loadedConfig);

  // Validate config version and schema (after config is available)
  if (loadedConfig && Object.keys(loadedConfig).length > 0) {
    const { validateConfigSchema, CURRENT_VERSION, semverLt, getMigrationsNeeded } = require('../utils/config-schema');
    const configVersion = loadedConfig.config_version || '1.0.0';
    
    // Check if config has version field
    if (!loadedConfig.config_version) {
      auditResults.configOutdated = {
        hasVersion: false,
        currentVersion: '1.0.0',
        latestVersion: CURRENT_VERSION,
        message: 'factiii.yml missing config_version field (pre-1.1.0 format)',
        canAutoFix: true
      };
    } else if (semverLt(configVersion, CURRENT_VERSION)) {
      // Config is outdated
      auditResults.configOutdated = {
        hasVersion: true,
        currentVersion: configVersion,
        latestVersion: CURRENT_VERSION,
        message: `factiii.yml is outdated (${configVersion} < ${CURRENT_VERSION})`,
        canAutoFix: true,
        migrations: getMigrationsNeeded(configVersion, CURRENT_VERSION)
      };
    }
    
    // Validate schema
    const schemaValidation = validateConfigSchema(loadedConfig, CURRENT_VERSION);
    if (!schemaValidation.valid || schemaValidation.newOptional.length > 0) {
      auditResults.configSchema = schemaValidation;
    }
  }

  // Validate GitHub secrets (after config is available)
  if (loadedConfig.environments) {
    auditResults.githubSecrets = await validateGitHubSecrets(loadedConfig);
  }

  // Validate config sync with workflows (after workflows are generated)
  auditResults.configSync = null;
  if (loadedConfig) {
    const { validateConfigSync } = require('../utils/config-validator');
    auditResults.configSync = validateConfigSync(rootDir);
  }

  // Validate DNS hostnames (after config is available)
  auditResults.dnsValidation = {};
  if (loadedConfig.environments) {
    const { isHostnameResolvable, findResolvableAlternative } = require('../utils/dns-validator');
    
    for (const [envName, envConfig] of Object.entries(loadedConfig.environments)) {
      if (envConfig.host) {
        const isResolvable = await isHostnameResolvable(envConfig.host);
        
        auditResults.dnsValidation[envName] = {
          hostname: envConfig.host,
          resolvable: isResolvable,
          alternative: null,
          canAutoFix: false
        };
        
        if (!isResolvable) {
          // Try to find alternative
          const alternative = await findResolvableAlternative(envConfig.host);
          if (alternative) {
            auditResults.dnsValidation[envName].alternative = alternative;
            auditResults.dnsValidation[envName].canAutoFix = true;
          }
        }
      }
    }
  }

  // Check servers if we have GitHub token and SSH keys
  auditResults.servers = {};
  if (loadedConfig.environments && auditResults.githubSecrets && auditResults.githubSecrets.tokenAvailable) {
    const { GitHubSecretsStore } = require('../utils/github-secrets');
    const { scanServerAndValidateConfigs } = require('../utils/server-check');
    
    const token = process.env.GITHUB_TOKEN;
    if (token) {
      const secretStore = new GitHubSecretsStore(token);
      
      for (const [envName, envConfig] of Object.entries(loadedConfig.environments)) {
        try {
          // Get SSH key for this environment
          const sshKeyName = `${envName.toUpperCase()}_SSH`;
          const secrets = await secretStore.getSecrets([sshKeyName]);
          const sshKey = secrets[sshKeyName];
          
          if (sshKey) {
            auditResults.servers[envName] = await scanServerAndValidateConfigs(
              envName,
              envConfig,
              loadedConfig,
              sshKey
            );
          } else {
            auditResults.servers[envName] = {
              ssh: false,
              error: 'SSH key not found in GitHub secrets'
            };
          }
        } catch (error) {
          auditResults.servers[envName] = {
            ssh: false,
            error: error.message
          };
        }
      }
    }
  }

  // Generate workflows if needed
  if (shouldGenerateWorkflows) {
    try {
      generateWorkflows({ output: '.github/workflows' });
      // Update audit results after generation
      auditResults.workflows = checkWorkflowsStatus(rootDir);
    } catch (error) {
      console.log(`⚠️  Warning: Failed to generate workflows: ${error.message}\n`);
      // Will be shown in audit report
    }
  }

  // Display comprehensive audit report
  const summary = displayAuditReport(auditResults);

  // Display conditional next steps
  displayNextSteps(auditResults);

  // Final message
  if (summary.critical === 0 && summary.warnings === 0) {
    console.log('✅ All checks passed! Deploy will work.\n');
    console.log('   Next: npx factiii deploy\n');
  } else if (summary.critical === 0) {
    console.log('✅ No critical issues. Deploy will work.\n');
    console.log('   💡 Optional improvements recommended (see above)\n');
    console.log('   Next: npx factiii deploy\n');
  } else {
    console.log('❌ Critical issues found (see above)\n');
    console.log('   Next: npx factiii fix\n');
  }

  // Return summary for use by other commands (e.g., fix)
  // Return both summary and audit results for use by fix
  return { 
    ...summary,
    auditResults 
  };
}

module.exports = scan;
