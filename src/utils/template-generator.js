const fs = require('fs');
const path = require('path');

/**
 * Generate .env.example template file content
 * @param {object} config - Parsed core.yml configuration
 * @returns {string} - Template file content
 */
function generateEnvExampleTemplate(config) {
  const repoName = config.name || 'myapp';
  
  const template = `# .env.example - Environment variable template
# This file defines all required environment variables across environments.
# Values are descriptive examples - replace with real values in .env.staging and .env.prod
# This file is committed to git as a template.

# === Application Settings ===
NODE_ENV=development
PORT=3000

# === Database ===
# PostgreSQL connection string format
DATABASE_URL=postgresql://EXAMPLE-user:EXAMPLE-password@localhost:5432/EXAMPLE-${repoName}-dev

# === Authentication ===
# 256-bit secret key for JWT signing
JWT_SECRET=EXAMPLE-your-256-bit-secret-key-here
JWT_EXPIRES_IN=7d

# === External APIs (if needed) ===
# OPENAI_API_KEY=EXAMPLE-sk-proj-abc123xyz789
# STRIPE_SECRET_KEY=EXAMPLE-sk_test_51ABC123xyz
# STRIPE_PUBLISHABLE_KEY=EXAMPLE-pk_test_51ABC123xyz

# === AWS Configuration (if using S3, SES, etc) ===
# AWS_ACCESS_KEY_ID=EXAMPLE-AKIAIOSFODNN7EXAMPLE
# AWS_SECRET_ACCESS_KEY=EXAMPLE-wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
# AWS_REGION=EXAMPLE-us-east-1
# AWS_BUCKET_NAME=EXAMPLE-${repoName}-assets

# === Email Configuration (if using SMTP) ===
# SMTP_HOST=EXAMPLE-smtp.gmail.com
# SMTP_PORT=587
# SMTP_USER=EXAMPLE-noreply@yourdomain.com
# SMTP_PASSWORD=EXAMPLE-your-app-password

# === Application URLs ===
# FRONTEND_URL=EXAMPLE-http://localhost:3000
# API_URL=EXAMPLE-http://localhost:3001

# === Application-specific settings ===
# Add your custom environment variables below
`;
  
  return template;
}

/**
 * Generate .env template file content for staging/prod
 * Copies structure from .env.example with placeholder values
 * @param {string} environment - 'staging' or 'prod'
 * @param {object} devEnv - Parsed .env.example key-value pairs
 * @returns {string} - Template file content
 */
function generateEnvTemplate(environment, devEnv) {
  const envUpper = environment.toUpperCase();
  
  let template = `# .env.${environment} - ${envUpper} environment variables
# Fill in all values below. Keys must match .env.example
# This file should ${environment === 'prod' ? 'ALWAYS' : 'optionally'} be in .gitignore

`;
  
  // Copy keys from .env.example with placeholder values
  for (const key of Object.keys(devEnv)) {
    const devValue = devEnv[key];
    
    // If dev value is not an example, use it as a guide
    if (devValue && !devValue.includes('EXAMPLE')) {
      template += `${key}=${devValue}\n`;
    } else {
      // Use placeholder
      template += `${key}=<FILL_IN>\n`;
    }
  }
  
  template += `
# Instructions:
# 1. Replace all <FILL_IN> values with real ${environment} values
# 2. Ensure all keys match .env.example
# 3. Run: npx core init (to validate)
`;
  
  return template;
}

/**
 * Create .env template files if they don't exist
 * @param {string} rootDir - Repository root directory
 * @param {object} config - Parsed core.yml configuration
 * @returns {object} - Results with created files
 */
function createEnvTemplates(rootDir, config) {
  const result = {
    created: [],
    skipped: [],
    errors: []
  };
  
  // Create .env.example first (template)
  const devPath = path.join(rootDir, '.env.example');
  try {
    if (fs.existsSync(devPath)) {
      result.skipped.push('.env.example');
    } else {
      const devTemplate = generateEnvExampleTemplate(config);
      fs.writeFileSync(devPath, devTemplate, 'utf8');
      result.created.push('.env.example');
    }
  } catch (error) {
    result.errors.push({
      file: '.env.example',
      error: error.message
    });
    // Can't create staging/prod without example template
    return result;
  }
  
  // Parse .env.example to use as template for staging/prod
  const { parseEnvFile } = require('./env-validator');
  const devEnv = parseEnvFile(devPath);
  
  if (!devEnv) {
    result.errors.push({
      file: 'staging/prod',
      error: 'Could not parse .env.example to generate templates'
    });
    return result;
  }
  
  // Create staging and prod templates based on example
  const environments = ['staging', 'prod'];
  
  for (const env of environments) {
    const filename = `.env.${env}`;
    const filepath = path.join(rootDir, filename);
    
    try {
      // Check if file already exists
      if (fs.existsSync(filepath)) {
        result.skipped.push(filename);
        continue;
      }
      
      // Generate and write template based on .env.example
      const template = generateEnvTemplate(env, devEnv);
      fs.writeFileSync(filepath, template, 'utf8');
      result.created.push(filename);
      
    } catch (error) {
      result.errors.push({
        file: filename,
        error: error.message
      });
    }
  }
  
  return result;
}

/**
 * Generate secrets checklist for display
 */
function generateSecretsChecklist() {
  return `
   REQUIRED GitHub Secrets (minimal):
   ───────────────────────────────────────────────────────
   □ STAGING_SSH           - SSH private key for staging
   □ PROD_SSH              - SSH private key for production
   □ AWS_SECRET_ACCESS_KEY - AWS secret key (only secret AWS value)

   OPTIONAL GitHub Secrets:
   ───────────────────────────────────────────────────────
   □ STAGING_ENVS   - Environment vars from .env.staging
   □ PROD_ENVS      - Environment vars from .env.prod

   NOT SECRETS (in core.yml):
   ───────────────────────────────────────────────────────
   ✓ environments.{env}.host - Server IP/hostname
   ✓ aws.access_key_id       - AWS access key ID
   ✓ aws.region              - AWS region (e.g., us-east-1)

   NOT SECRETS (in coreAuto.yml):
   ───────────────────────────────────────────────────────
   ✓ ssh_user               - Defaults to ubuntu
`.trim();
}

module.exports = {
  generateEnvExampleTemplate,
  generateEnvTemplate,
  createEnvTemplates,
  generateSecretsChecklist
};

