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
  // Note: Core GENERATES these for repos but does NOT use them itself
  // These are repo CI/CD workflows that run independently on git events
  const workflows = [
    'core-staging.yml',
    'core-production.yml',
    'core-undeploy.yml'
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
  
  console.log(`\n💡 Key Distinction:`);
  console.log(`   Core GENERATES these workflows for your repo but does NOT use them itself.`);
  console.log(`   These are YOUR repo's CI/CD workflows - they run independently on git events.\n`);
  
  console.log(`📝 Generated workflows:`);
  console.log(`   - core-staging.yml: Auto-deploy on PR/push to main branch`);
  console.log(`   - core-production.yml: Auto-deploy on merge to production branch`);
  console.log(`   - core-undeploy.yml: Manual cleanup trigger (optional)\n`);
  
  console.log(`📋 How they work:`);
  console.log(`   1. Workflows run automatically when you push/merge code`);
  console.log(`   2. They build, test, and deploy your app independently`);
  console.log(`   3. Core is NOT involved - these are standard GitHub Actions\n`);
  
  console.log(`📋 Required GitHub Secrets:`);
  console.log(`   - STAGING_SSH, STAGING_HOST, STAGING_USER`);
  console.log(`   - PROD_SSH, PROD_HOST, PROD_USER`);
  console.log(`   - AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION`);
  console.log(`\n💡 Run 'npx core init fix' to set up secrets automatically.`);
}


module.exports = generateWorkflows;


