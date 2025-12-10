const fs = require('fs');
const path = require('path');

function generateWorkflows(options = {}) {
  const rootDir = process.cwd();
  const outputDir = path.resolve(rootDir, options.output || '.github/workflows');
  const workflowsDir = path.join(__dirname, '../workflows');

  console.log(`📝 Generating GitHub workflows...\n`);

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  // Copy workflow templates
  const workflows = [
    'check-config.yml',
    'deploy-staging.yml',
    'deploy-prod.yml'
  ];

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
      const configPath = path.join(rootDir, 'infrastructure.yml');
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

    fs.writeFileSync(outputPath, content);
    console.log(`✅ Generated: ${outputPath}`);
  }

  console.log(`\n✅ Workflows generated successfully!`);
  console.log(`\n📋 Next steps:`);
  console.log(`   1. Review the generated workflow files`);
  console.log(`   2. Add GitHub secrets: STAGING_SSH, PROD_SSH, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION`);
  console.log(`   3. Commit and push the workflows`);
}

module.exports = generateWorkflows;


