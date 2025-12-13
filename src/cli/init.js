const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { execSync } = require('child_process');
const generateWorkflows = require('./generate-workflows');

/**
 * Check core.yml status and detect if it needs customization
 */
function checkCoreYmlStatus(rootDir, templatePath) {
  const configPath = path.join(rootDir, 'core.yml');
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
 */
function checkWorkflowsStatus(rootDir) {
  const workflowsDir = path.join(rootDir, '.github', 'workflows');
  const result = {
    deployExists: false,
    undeployExists: false,
    initExists: false,
    allExist: false
  };

  const deployPath = path.join(workflowsDir, 'deploy.yml');
  const undeployPath = path.join(workflowsDir, 'undeploy.yml');
  const initPath = path.join(workflowsDir, 'init.yml');

  result.deployExists = fs.existsSync(deployPath);
  result.undeployExists = fs.existsSync(undeployPath);
  result.initExists = fs.existsSync(initPath);
  result.allExist = result.deployExists && result.undeployExists && result.initExists;

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
 * Validate repository scripts and Prisma configuration
 */
function validateRepoScripts(rootDir) {
  const packageJsonPath = path.join(rootDir, 'package.json');
  const results = {
    hasPackageJson: false,
    requiredScripts: {
      test: false,
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
    results.requiredScripts.test = !!scripts.test;
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
  const { coreYml, workflows, repoScripts, branches, envFiles } = auditResults;

  console.log('🚀 Running infrastructure audit...\n');
  console.log('=' .repeat(60));

  // 1. Configuration Status
  console.log('\n📋 Configuration Status:');
  if (!coreYml.exists) {
    console.log('   ❌ core.yml does not exist');
    console.log('      Will create on first run or with --force flag');
  } else if (coreYml.parseError) {
    console.log('   ❌ core.yml has parsing errors');
    console.log(`      Error: ${coreYml.parseError}`);
  } else if (coreYml.needsCustomization) {
    console.log('   ⚠️  core.yml exists but needs customization');
    console.log('      Placeholder values detected:');
    for (const placeholder of coreYml.placeholders) {
      console.log(`         - ${placeholder.field}: ${placeholder.value}`);
    }
    console.log('      💡 Edit core.yml with your actual values');
  } else {
    console.log('   ✅ core.yml exists and is customized');
  }

  // 2. GitHub Workflows
  console.log('\n📝 GitHub Workflows:');
  if (workflows.allExist) {
    console.log('   ✅ init.yml exists');
    console.log('   ✅ deploy.yml exists');
    console.log('   ✅ undeploy.yml exists');
  } else {
    if (!workflows.initExists) {
      console.log('   ❌ init.yml missing');
    } else {
      console.log('   ✅ init.yml exists');
    }
    if (!workflows.deployExists) {
      console.log('   ❌ deploy.yml missing');
    } else {
      console.log('   ✅ deploy.yml exists');
    }
    if (!workflows.undeployExists) {
      console.log('   ❌ undeploy.yml missing');
    } else {
      console.log('   ✅ undeploy.yml exists');
    }
    if (!workflows.allExist) {
      console.log('      💡 Run: npx core generate-workflows');
    }
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
      if (!repoScripts.requiredScripts.test) {
        console.log('          "test": "pnpm -r --filter \'./apps/*\' test",  // Run all tests');
      }
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
      
      // Check if core.yml has it configured
      if (coreYml.config?.prisma_schema) {
        if (coreYml.config.prisma_schema === repoScripts.prismaSchemaPath) {
          console.log('   ✅ core.yml prisma_schema matches detected location');
        } else {
          console.log('   ⚠️  core.yml prisma_schema differs from detected:');
          console.log(`      Config: ${coreYml.config.prisma_schema}`);
          console.log(`      Found:  ${repoScripts.prismaSchemaPath}`);
          console.log('      💡 Run: npx core init --force to update');
        }
      }
      
      // Check version match
      if (coreYml.config?.prisma_version && repoScripts.prismaVersion) {
        if (coreYml.config.prisma_version !== repoScripts.prismaVersion) {
          console.log('   ⚠️  Version mismatch:');
          console.log(`      core.yml: ${coreYml.config.prisma_version}`);
          console.log(`      package.json: ${repoScripts.prismaVersion}`);
          console.log('      💡 Run: npx core init --force to update');
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
  console.log('\n🔑 GitHub Secrets (verify in repository Settings → Secrets):');
  console.log('   ℹ️  Required secrets for deployment:');
  console.log('      - STAGING_SSH, PROD_SSH (SSH private keys)');
  console.log('      - STAGING_HOST, PROD_HOST (server addresses)');
  console.log('      - STAGING_USER, PROD_USER (SSH users, default: ubuntu)');
  console.log('      - AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION');
  console.log('      - STAGING_ENVS, PROD_ENVS (managed via .env files)');
  console.log('      💡 Run init workflow to sync .env files to GitHub');

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

  // 7. Summary
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

  if (workflows.allExist) {
    passed++;
  } else {
    warnings++;
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
    steps.push('Run this command again to create core.yml');
  } else if (coreYml.needsCustomization) {
    steps.push('Edit core.yml with your actual domains and settings');
  }

  if (!workflows.allExist) {
    steps.push('Generate workflows: npx core generate-workflows');
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

  steps.push('Add GitHub secrets (see list above)');
  steps.push('Commit and push changes to trigger deployment');
  steps.push('Test deployment: npx core deploy');

  // Display steps
  steps.forEach((step, index) => {
    console.log(`   ${index + 1}. ${step}`);
  });

  console.log('');
}

/**
 * Main init function - now acts as comprehensive audit tool
 */
async function init(options = {}) {
  const rootDir = process.cwd();
  const configPath = path.join(rootDir, 'core.yml');
  const templatePath = path.join(__dirname, '../../templates/core.yml.example');

  // Always run comprehensive audit
  const auditResults = {
    coreYml: checkCoreYmlStatus(rootDir, templatePath),
    workflows: checkWorkflowsStatus(rootDir),
    repoScripts: validateRepoScripts(rootDir),
    branches: checkBranchStatus(rootDir),
    envFiles: null // Will be added after config is loaded
  };

  // Determine if we should create/update files
  const shouldCreateCoreYml = !auditResults.coreYml.exists || options.force;
  // Always check workflows for updates (it will detect if no changes needed)
  const shouldGenerateWorkflows = true;

  // Create core.yml if needed
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
    let config = template.replace(/your-repo-name/g, repoName);

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
  
  // Validate environment files (after config is available)
  const { validateEnvFiles } = require('../utils/env-validator');
  const loadedConfig = auditResults.coreYml.config || {};
  auditResults.envFiles = validateEnvFiles(rootDir, loadedConfig);

  // Generate workflows if needed
  if (shouldGenerateWorkflows) {
    try {
      generateWorkflows({ output: '.github/workflows' });
      // Update audit results
      auditResults.workflows = checkWorkflowsStatus(rootDir);
    } catch (error) {
      // Will be shown in audit report
    }
  }

  // Display comprehensive audit report
  const summary = displayAuditReport(auditResults);

  // Display conditional next steps
  displayNextSteps(auditResults);

  // Final message and auto-trigger workflow if checks pass
  if (summary.critical === 0 && summary.warnings === 0) {
    console.log('✨ All checks passed! Your infrastructure is ready.\n');
    
    // Auto-trigger workflow if --no-remote flag not set
    if (!options.noRemote) {
      await triggerAndWaitForWorkflow(auditResults, options);
    } else {
      displayWorkflowInstructions(auditResults);
    }
  } else if (summary.critical === 0) {
    console.log('✨ Setup is functional but some improvements recommended.\n');
    console.log('   💡 Run \'npx core init\' anytime to re-check your setup.\n');
    
    // Auto-trigger workflow even with warnings if --no-remote flag not set
    if (!options.noRemote) {
      await triggerAndWaitForWorkflow(auditResults, options);
    } else {
      displayWorkflowInstructions(auditResults);
    }
  } else {
    console.log('⚠️  Please address critical issues before deploying.\n');
    console.log('   💡 Run \'npx core init\' again after making changes.\n');
    console.log('   Skipping workflow trigger due to critical issues.\n');
  }

  // Always exit 0 (permissive mode)
}

/**
 * Auto-trigger init workflow and wait for results
 */
async function triggerAndWaitForWorkflow(auditResults, options) {
  const { branches, workflows } = auditResults;
  
  if (!workflows.initExists) {
    console.log('⚠️  Init workflow not found. Run: npx core generate-workflows\n');
    return;
  }
  
  // Get GitHub token
  const token = options.token || process.env.GITHUB_TOKEN;
  
  if (!token) {
    console.log('⚠️  No GITHUB_TOKEN found. Cannot auto-trigger workflow.\n');
    displayWorkflowInstructions(auditResults);
    return;
  }
  
  // Get repo info
  const { getGitHubRepoInfo } = require('../utils/github-secrets');
  const repoInfo = getGitHubRepoInfo();
  
  if (!repoInfo) {
    console.log('⚠️  Could not detect GitHub repository.\n');
    displayWorkflowInstructions(auditResults);
    return;
  }
  
  console.log('🚀 Auto-triggering Init Workflow...\n');
  
  const { Octokit } = require('@octokit/rest');
  const octokit = new Octokit({ auth: token });
  
  try {
    // Get current branch
    let currentBranch = branches.currentBranch || 'main';
    
    // Trigger workflow
    await octokit.rest.actions.createWorkflowDispatch({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      workflow_id: 'init.yml',
      ref: currentBranch
    });
    
    console.log(`✅ Workflow triggered on branch: ${currentBranch}`);
    console.log(`   Repository: ${repoInfo.owner}/${repoInfo.repo}\n`);
    
    // Wait a moment for workflow to be created
    console.log('⏳ Waiting for workflow to start...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Find the latest workflow run
    const { data: runs } = await octokit.rest.actions.listWorkflowRuns({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      workflow_id: 'init.yml',
      per_page: 1
    });
    
    if (runs.workflow_runs.length === 0) {
      console.log('⚠️  Could not find workflow run.');
      console.log(`   View manually: https://github.com/${repoInfo.owner}/${repoInfo.repo}/actions\n`);
      return;
    }
    
    const run = runs.workflow_runs[0];
    console.log(`📋 Workflow run: ${run.html_url}\n`);
    
    // Poll for completion
    let status = run.status;
    let conclusion = run.conclusion;
    const startTime = Date.now();
    const timeout = 5 * 60 * 1000; // 5 minutes
    
    while (status !== 'completed') {
      if (Date.now() - startTime > timeout) {
        console.log('\n⏱️  Workflow is taking longer than expected.');
        console.log(`   View progress: ${run.html_url}\n`);
        return;
      }
      
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      const { data: updatedRun } = await octokit.rest.actions.getWorkflowRun({
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        run_id: run.id
      });
      
      status = updatedRun.status;
      conclusion = updatedRun.conclusion;
      
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      process.stdout.write(`\r⏳ Status: ${status}... (${elapsed}s)`);
    }
    
    console.log('\n');
    
    // Display results based on conclusion
    if (conclusion === 'success') {
      console.log('✅ Init Workflow Completed Successfully!\n');
      console.log('📊 RESULTS:');
      console.log('   ✅ All GitHub secrets are configured');
      console.log('   ✅ SSH connections successful');
      console.log('   ✅ Server checks passed\n');
      console.log('💡 View full report: ' + run.html_url);
      console.log('\n🚀 Ready to deploy!');
      console.log('   Run: npx core deploy --environment staging\n');
    } else if (conclusion === 'failure') {
      console.log('⚠️  Init Workflow completed with issues\n');
      console.log('📊 RESULTS:');
      console.log('   ⚠️  Some secrets may be missing');
      console.log('   ⚠️  Check the workflow logs for details\n');
      console.log('💡 View full report: ' + run.html_url);
      console.log('\n📝 Next Steps:');
      console.log('   1. Review the workflow results');
      console.log('   2. Add missing GitHub secrets');
      console.log('   3. Fill in .env files if generated');
      console.log('   4. Run: npx core init (to verify fixes)\n');
    } else {
      console.log(`⚠️  Workflow completed with status: ${conclusion}\n`);
      console.log('💡 View details: ' + run.html_url + '\n');
    }
    
  } catch (error) {
    if (error.status === 401) {
      console.log('❌ GitHub token is invalid or expired');
      console.log('   Generate a new token with "repo" and "workflow" scopes\n');
    } else if (error.status === 403) {
      console.log('❌ GitHub token does not have permission to trigger workflows');
      console.log('   Ensure token has "repo" and "workflow" scopes\n');
    } else if (error.status === 404) {
      console.log('❌ Workflow not found. Make sure init.yml is committed and pushed.\n');
    } else {
      console.log(`❌ Failed to trigger workflow: ${error.message}\n`);
    }
    
    // Fall back to manual instructions
    displayWorkflowInstructions(auditResults);
  }
}

/**
 * Display instructions for running the init workflow (fallback for manual trigger)
 */
function displayWorkflowInstructions(auditResults) {
  const { branches, workflows } = auditResults;
  
  if (!workflows.initExists) {
    return; // Init workflow not generated yet
  }
  
  console.log('🚀 Manual Workflow Trigger Required\n');
  console.log('To run the Init workflow manually:');
  console.log('   • Verifies all GitHub secrets are configured');
  console.log('   • Tests SSH connections to staging/prod servers');
  console.log('   • Shows what\'s currently deployed on each server');
  console.log('   • Compares your local config with deployed versions');
  console.log('');
  
  if (branches.hasGit) {
    try {
      const { execSync } = require('child_process');
      const repoUrl = execSync('git config --get remote.origin.url', { 
        encoding: 'utf8',
        stdio: 'pipe'
      }).trim();
      
      const match = repoUrl.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/);
      if (match) {
        const owner = match[1];
        const repo = match[2];
        console.log('💡 How to run:');
        console.log(`   1. Commit and push your changes`);
        console.log(`   2. Go to: https://github.com/${owner}/${repo}/actions/workflows/init.yml`);
        console.log(`   3. Click "Run workflow"`);
        console.log('');
      }
    } catch (e) {
      // Ignore errors
    }
  }
  
  // Display secrets checklist
  const { generateSecretsChecklist } = require('../utils/template-generator');
  console.log(generateSecretsChecklist());
  console.log('');
}

module.exports = init;
