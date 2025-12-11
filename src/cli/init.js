const fs = require('fs');
const path = require('path');
const generateWorkflows = require('./generate-workflows');

/**
 * Validate repository scripts and Prisma configuration
 */
function validateRepoScripts(rootDir) {
  const packageJsonPath = path.join(rootDir, 'package.json');
  const results = {
    hasPackageJson: false,
    requiredScripts: {
      test: false,
      'build:docker:staging': false,
      'build:docker:prod': false
    },
    optionalScripts: {
      'db:backup': false,
      'db:restore': false,
      'test:integration': false
    },
    hasPrisma: false,
    hasPrismaSchema: false,
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
    results.requiredScripts['build:docker:staging'] = !!scripts['build:docker:staging'];
    results.requiredScripts['build:docker:prod'] = !!scripts['build:docker:prod'];

    // Check for optional scripts
    results.optionalScripts['db:backup'] = !!scripts['db:backup'];
    results.optionalScripts['db:restore'] = !!scripts['db:restore'];
    results.optionalScripts['test:integration'] = !!scripts['test:integration'];

    // Check for Prisma
    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {})
    };
    results.hasPrisma = !!(allDeps.prisma || allDeps['@prisma/client']);

    // Check for Prisma schema file
    const prismaSchemaPath = path.join(rootDir, 'prisma', 'schema.prisma');
    results.hasPrismaSchema = fs.existsSync(prismaSchemaPath);

  } catch (e) {
    // Ignore JSON parse errors
  }

  return results;
}

/**
 * Display validation results
 */
function displayValidation(validation) {
  console.log(`\n📋 Repository Validation:\n`);

  if (!validation.hasPackageJson) {
    console.log('⚠️  No package.json found');
    console.log('   This repository may not be a Node.js project\n');
    return;
  }

  // Required scripts
  console.log('📦 Required Scripts in package.json:');
  const requiredAll = Object.entries(validation.requiredScripts).every(([_, exists]) => exists);
  
  for (const [script, exists] of Object.entries(validation.requiredScripts)) {
    if (exists) {
      console.log(`   ✅ ${script}`);
    } else {
      console.log(`   ❌ ${script} - MISSING`);
    }
  }

  if (!requiredAll) {
    console.log(`\n💡 Add missing scripts to package.json:`);
    console.log(`   {`);
    console.log(`     "scripts": {`);
    if (!validation.requiredScripts.test) {
      console.log(`       "test": "jest",  // or your test framework`);
    }
    if (!validation.requiredScripts['build:docker:staging']) {
      console.log(`       "build:docker:staging": "docker build -t staging-app .",`);
    }
    if (!validation.requiredScripts['build:docker:prod']) {
      console.log(`       "build:docker:prod": "docker build -t prod-app .",`);
    }
    console.log(`     }`);
    console.log(`   }\n`);
  } else {
    console.log('');
  }

  // Optional scripts
  const hasOptional = Object.values(validation.optionalScripts).some(v => v);
  if (hasOptional) {
    console.log('📦 Optional Scripts:');
    for (const [script, exists] of Object.entries(validation.optionalScripts)) {
      if (exists) {
        console.log(`   ✅ ${script}`);
      }
    }
    console.log('');
  }

  // Prisma configuration
  console.log('🔷 Prisma Configuration:');
  if (validation.hasPrisma) {
    console.log(`   ✅ Prisma installed`);
    if (validation.hasPrismaSchema) {
      console.log(`   ✅ prisma/schema.prisma found`);
    } else {
      console.log(`   ⚠️  prisma/schema.prisma not found - Run: npx prisma init`);
    }
    
    if (!validation.optionalScripts['db:backup']) {
      console.log(`\n💡 Recommended: Add database backup script:`);
      console.log(`   "db:backup": "pg_dump $DATABASE_URL > backup.sql"`);
      console.log(`   (Will use default Prisma-based backup if not provided)`);
    }
  } else {
    console.log(`   ⚠️  Prisma not installed`);
    console.log(`   Production workflow assumes Prisma for migrations`);
    console.log(`   Install: npm install -D prisma @prisma/client\n`);
  }
}

function init(options = {}) {
  const rootDir = process.cwd();
  const configPath = path.join(rootDir, 'core.yml');
  const templatePath = path.join(__dirname, '../../templates/core.yml.example');

  console.log('🚀 Initializing infrastructure configuration...\n');

  // Check if config already exists
  if (fs.existsSync(configPath) && !options.force) {
    console.error('❌ core.yml already exists. Use --force to overwrite.');
    process.exit(1);
  }

  // Read template
  if (!fs.existsSync(templatePath)) {
    console.error(`❌ Template not found: ${templatePath}`);
    process.exit(1);
  }

  const template = fs.readFileSync(templatePath, 'utf8');
  
  // Try to infer repo name from package.json or git
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
  const config = template.replace(/your-repo-name/g, repoName);

  // Write config file
  fs.writeFileSync(configPath, config);
  console.log(`✅ Created core.yml`);
  console.log(`   Repository name: ${repoName}\n`);

  // Generate workflows automatically
  console.log('📝 Generating GitHub workflows...\n');
  try {
    generateWorkflows({ output: '.github/workflows' });
  } catch (error) {
    console.error(`⚠️  Failed to generate workflows: ${error.message}`);
    console.log(`   Run manually: npx core generate-workflows\n`);
  }

  // Validate repository configuration
  const validation = validateRepoScripts(rootDir);
  displayValidation(validation);

  // Final instructions
  console.log(`\n📝 Next Steps:\n`);
  
  const missingScripts = Object.entries(validation.requiredScripts)
    .filter(([_, exists]) => !exists)
    .map(([script, _]) => script);

  if (missingScripts.length > 0) {
    console.log(`   1. Add missing scripts to package.json (see above)`);
    console.log(`   2. Edit core.yml with your actual domains and settings`);
    console.log(`   3. Add GitHub secrets:`);
  } else {
    console.log(`   1. Edit core.yml with your actual domains and settings`);
    console.log(`   2. Add GitHub secrets:`);
  }
  
  console.log(`      - STAGING_SSH, PROD_SSH (SSH private keys)`);
  console.log(`      - STAGING_HOST, PROD_HOST (server addresses)`);
  console.log(`      - AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION`);
  console.log(`      - STAGING_ENVS, PROD_ENVS (environment variables)`);
  console.log(`      - ECR_REPOSITORY (default: apps)`);
  
  if (!validation.hasPrisma) {
    console.log(`   ${missingScripts.length > 0 ? '4' : '3'}. Install Prisma: npm install -D prisma @prisma/client`);
    console.log(`   ${missingScripts.length > 0 ? '5' : '4'}. Initialize Prisma: npx prisma init`);
    console.log(`   ${missingScripts.length > 0 ? '6' : '5'}. Create staging and production branches`);
    console.log(`   ${missingScripts.length > 0 ? '7' : '6'}. Commit and push changes`);
    console.log(`   ${missingScripts.length > 0 ? '8' : '7'}. Test with: npx core deploy`);
  } else {
    console.log(`   ${missingScripts.length > 0 ? '4' : '3'}. Create staging and production branches`);
    console.log(`   ${missingScripts.length > 0 ? '5' : '4'}. Commit and push changes`);
    console.log(`   ${missingScripts.length > 0 ? '6' : '5'}. Test with: npx core deploy`);
  }

  console.log(`\n✨ Initialization complete!\n`);
}

module.exports = init;
