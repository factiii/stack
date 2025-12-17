const fs = require('fs');
const path = require('path');

function generateWorkflows(options = {}) {
  const rootDir = process.cwd();
  const outputDir = path.resolve(rootDir, options.output || '.github/workflows');
  
  // First, try the new plugin location, then fall back to old location
  let workflowsDir = path.join(__dirname, '../plugins/pipelines/factiii/workflows');
  if (!fs.existsSync(workflowsDir)) {
    workflowsDir = path.join(__dirname, '../workflows');
  }

  console.log(`📝 Generating GitHub workflows...\n`);

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  // Thin workflow files - just SSH and call CLI
  const workflows = [
    'factiii-deploy.yml',      // Manual deployment (triggered by npx factiii deploy)
    'factiii-staging.yml',     // Auto-deploy on push to main
    'factiii-production.yml',  // Auto-deploy on merge to production
    'factiii-undeploy.yml'     // Manual cleanup
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
      const configPath = path.join(rootDir, 'factiii.yml');
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
  
  console.log(`\n💡 How thin workflows work:`);
  console.log(`   1. Workflow SSHs into your server`);
  console.log(`   2. Runs: npx factiii deploy --{environment}`);
  console.log(`   3. All logic runs on server (not in workflow)\n`);
  
  console.log(`📝 Generated workflows:`);
  console.log(`   - factiii-deploy.yml: Manual deployment (triggered by npx factiii deploy)`);
  console.log(`   - factiii-staging.yml: Auto-deploy on push to main branch`);
  console.log(`   - factiii-production.yml: Auto-deploy on merge to production branch`);
  console.log(`   - factiii-undeploy.yml: Manual cleanup trigger\n`);
  
  console.log(`📋 Required GitHub Secrets:`);
  console.log(`   - STAGING_SSH (SSH private key for staging)`);
  console.log(`   - PROD_SSH (SSH private key for production)`);
  console.log(`   - AWS_SECRET_ACCESS_KEY (if using ECR)\n`);
  
  console.log(`💡 Run 'npx factiii fix' to set up secrets automatically.`);
}


module.exports = generateWorkflows;
