const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

function validate(options = {}) {
  const rootDir = process.cwd();
  const configPath = path.resolve(rootDir, options.config || 'factiii.yml');

  if (!fs.existsSync(configPath)) {
    console.error(`❌ Config file not found: ${configPath}`);
    process.exit(1);
  }

  console.log(`📋 Validating ${configPath}...\n`);

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const config = yaml.load(content);

    const errors = [];
    const warnings = [];
    const exampleValues = [];

    // Check for EXAMPLE- placeholder values (recursive scan of actual YAML values only)
    // This properly ignores comments since we're scanning the parsed YAML object
    function scanForExamples(obj, path = '') {
      if (typeof obj === 'string' && obj.includes('EXAMPLE-')) {
        exampleValues.push({ path: path || 'root', value: obj });
      } else if (typeof obj === 'object' && obj !== null) {
        for (const [key, value] of Object.entries(obj)) {
          const newPath = path ? `${path}.${key}` : key;
          scanForExamples(value, newPath);
        }
      }
    }
    
    scanForExamples(config);

    // EXAMPLE- values are blocking errors
    if (exampleValues.length > 0) {
      console.error('❌ Configuration contains EXAMPLE- placeholder values:\n');
      exampleValues.forEach(({ path, value }) => {
        console.error(`   ${path}: ${value}`);
      });
      console.error('\n💡 Please replace all EXAMPLE- values with your actual configuration.');
      console.error('   Edit factiii.yml and replace these placeholder values.\n');
      process.exit(1);
    }

    // Validate required fields
    if (!config.name) {
      errors.push('Missing required field: name');
    }

    if (!config.environments) {
      errors.push('Missing required field: environments');
    } else {
      // Validate environments
      if (!config.environments.staging && !config.environments.prod) {
        errors.push('At least one environment (staging or prod) must be defined');
      }

      for (const [env, envConfig] of Object.entries(config.environments)) {
        if (!envConfig.domain) {
          errors.push(`Missing domain for ${env} environment`);
        }

        if (envConfig.port && (envConfig.port < 3000 || envConfig.port > 65535)) {
          warnings.push(`Port ${envConfig.port} for ${env} may be outside recommended range (3000-65535)`);
        }
      }
    }

    // Validate global settings
    if (!config.ssl_email) {
      warnings.push('Missing ssl_email - SSL certificates may not work properly');
    }

    if (!config.ecr_registry) {
      warnings.push('Missing ecr_registry - Docker image pulls may fail');
    }

    if (!config.ecr_repository) {
      warnings.push('Missing ecr_repository - Docker image pulls may fail');
    }

    // Print results
    if (errors.length > 0) {
      console.error('❌ Validation failed:\n');
      errors.forEach(err => console.error(`   - ${err}`));
      process.exit(1);
    }

    if (warnings.length > 0) {
      console.log('⚠️  Warnings:\n');
      warnings.forEach(warn => console.log(`   - ${warn}`));
      console.log('');
    }

    console.log('✅ Configuration is valid!\n');
    console.log(`   Repository: ${config.name}`);
    console.log(`   Environments: ${Object.keys(config.environments).join(', ')}`);
    
    for (const [env, envConfig] of Object.entries(config.environments)) {
      console.log(`   ${env}: ${envConfig.domain}${envConfig.port ? ` (port ${envConfig.port})` : ''}`);
    }

  } catch (error) {
    if (error.name === 'YAMLException') {
      console.error(`❌ YAML parsing error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

// Export validation function that can be used by scripts
function validateExampleValues(configPath) {
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const config = yaml.load(content);
    
    const exampleValues = [];
    
    function scanForExamples(obj, path = '') {
      if (typeof obj === 'string' && obj.includes('EXAMPLE-')) {
        exampleValues.push({ path: path || 'root', value: obj });
      } else if (typeof obj === 'object' && obj !== null) {
        for (const [key, value] of Object.entries(obj)) {
          const newPath = path ? `${path}.${key}` : key;
          scanForExamples(value, newPath);
        }
      }
    }
    
    scanForExamples(config);
    
    return {
      valid: exampleValues.length === 0,
      errors: exampleValues
    };
  } catch (error) {
    return {
      valid: false,
      errors: [{ path: 'parse_error', value: error.message }]
    };
  }
}

module.exports = validate;
module.exports.validateExampleValues = validateExampleValues;


