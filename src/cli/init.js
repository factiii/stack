const fs = require('fs');
const path = require('path');

function init(options = {}) {
  const rootDir = process.cwd();
  const configPath = path.join(rootDir, 'infrastructure.yml');
  const templatePath = path.join(__dirname, '../../templates/infrastructure.yml.example');

  // Check if config already exists
  if (fs.existsSync(configPath) && !options.force) {
    console.error('❌ infrastructure.yml already exists. Use --force to overwrite.');
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
  console.log(`✅ Created infrastructure.yml`);
  console.log(`   Repository name: ${repoName}`);
  console.log(`\n📝 Next steps:`);
  console.log(`   1. Edit infrastructure.yml with your domains and settings`);
  console.log(`   2. Add GitHub secrets: STAGING_SSH, PROD_SSH, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION`);
  console.log(`   3. Run: infra generate-workflows`);
}

module.exports = init;


