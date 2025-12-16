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
  // Note: core-deploy.yml is triggered by npx core deploy
  // Other workflows are repo CI/CD that run independently on git events
  const workflows = [
    'core-deploy.yml',      // Manual deployment (triggered by npx core deploy)
    'core-staging.yml',     // Auto-deploy on push to main/staging
    'core-production.yml',  // Auto-deploy on merge to production
    'core-undeploy.yml'     // Manual cleanup
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
  
  console.log(`\n💡 How deployments work:`);
  console.log(`   1. npx core deploy → triggers core-deploy.yml workflow`);
  console.log(`   2. Workflow has access to GitHub Secrets (secure)`);
  console.log(`   3. Workflow deploys to your servers via SSH\n`);
  
  console.log(`📝 Generated workflows:`);
  console.log(`   - core-deploy.yml: Manual deployment (triggered by npx core deploy)`);
  console.log(`   - core-staging.yml: Auto-deploy on PR/push to main branch (optional)`);
  console.log(`   - core-production.yml: Auto-deploy on merge to production branch (optional)`);
  console.log(`   - core-undeploy.yml: Manual cleanup trigger (optional)\n`);
  
  console.log(`📋 Auto-deploy workflows (optional):`);
  console.log(`   - Enable by pushing/merging to configured branches`);
  console.log(`   - They run independently and deploy automatically`);
  console.log(`   - Uses same secrets as manual deployment\n`);
  
  console.log(`📋 Required GitHub Secrets (minimal):`);
  console.log(`   - STAGING_SSH, PROD_SSH (SSH private keys)`);
  console.log(`   - AWS_SECRET_ACCESS_KEY`);
  console.log(`\n📋 Not secrets (in core.yml):`);
  console.log(`   - aws.access_key_id, aws.region`);
  console.log(`   - environments.{env}.host`);
  console.log(`\n💡 Run 'npx core init fix' to set up secrets automatically.`);
}


module.exports = generateWorkflows;


