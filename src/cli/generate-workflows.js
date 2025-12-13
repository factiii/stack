const fs = require('fs');
const path = require('path');

function generateWorkflows(options = {}) {
  const rootDir = process.cwd();
  const outputDir = path.resolve(rootDir, options.output || '.github/workflows');
  const workflowsDir = path.join(__dirname, '../workflows');

  console.log(`📝 Generating GitHub workflows...\n`);

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  // Copy workflow files (static files, no templates)
  const workflows = [
    'core-init.yml',
    'core-deploy.yml',
    'core-undeploy.yml',
    'core-staging.yml',
    'core-production.yml'
  ];

  let updated = 0;
  let unchanged = 0;
  let created = 0;

  for (const workflow of workflows) {
    const templatePath = path.join(workflowsDir, workflow);
    const outputPath = path.join(outputDir, workflow);

    if (!fs.existsSync(templatePath)) {
      console.error(`⚠️  Template not found: ${templatePath}`);
      continue;
    }

    let content = fs.readFileSync(templatePath, 'utf8');

    // Replace placeholders if needed (e.g., repo name)
    try {
      const configPath = path.join(rootDir, 'core.yml');
      if (fs.existsSync(configPath)) {
        const yaml = require('js-yaml');
        const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
        if (config.name) {
          content = content.replace(/{{REPO_NAME}}/g, config.name);
        }
      }
    } catch (e) {
      // Ignore errors
    }

    // Check if file exists and content differs
    const exists = fs.existsSync(outputPath);
    let shouldWrite = true;

    if (exists) {
      const existingContent = fs.readFileSync(outputPath, 'utf8');
      if (existingContent === content) {
        console.log(`⏭️  Unchanged: ${workflow}`);
        unchanged++;
        shouldWrite = false;
      } else {
        console.log(`🔄 Updated: ${workflow}`);
        updated++;
      }
    } else {
      console.log(`✅ Created: ${workflow}`);
      created++;
    }

    if (shouldWrite) {
      fs.writeFileSync(outputPath, content);
    }
  }

  console.log(`\n✅ Workflow generation complete!`);
  console.log(`   📊 Summary: ${created} created, ${updated} updated, ${unchanged} unchanged`);
  console.log(`\n📝 Generated workflows:`);
  console.log(`   - core-init.yml: Deployment readiness checker (verifies secrets and server state)`);
  console.log(`   - core-deploy.yml: Infrastructure configuration management (triggered by CLI)`);
  console.log(`   - core-undeploy.yml: Remove repository from servers`);
  console.log(`   - core-staging.yml: Application CI/CD for staging environment`);
  console.log(`   - core-production.yml: Application CI/CD for production with migrations`);
  console.log(`\n📋 Next steps:`);
  console.log(`   1. Review the generated workflow files`);
  console.log(`   2. Add required package.json scripts (see validation output)`);
  console.log(`   3. Add GitHub secrets: STAGING_SSH, PROD_SSH, STAGING_HOST, PROD_HOST, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION`);
  console.log(`   4. Create staging and production branches`);
  console.log(`   5. Commit and push the workflows`);
}

module.exports = generateWorkflows;


