const readline = require('readline');

/**
 * Secret metadata with help text and validation
 * 
 * Simplified secrets (per architecture):
 * - {ENV}_SSH: SSH private key for each environment
 * - AWS_SECRET_ACCESS_KEY: Only truly secret AWS value
 * 
 * Not secrets (in factiii.yml):
 * - HOST: environments.{env}.host
 * - AWS_ACCESS_KEY_ID: aws.access_key_id
 * - AWS_REGION: aws.region
 */
const SECRET_METADATA = {
  STAGING_SSH: {
    type: 'ssh_key',
    description: 'SSH private key for accessing staging server',
    helpText: `
   Step 1: Generate a new SSH key pair:
   ssh-keygen -t ed25519 -C "staging-deploy" -f ~/.ssh/staging_deploy
   
   Step 2: Add PUBLIC key to your staging server:
   ssh-copy-id -i ~/.ssh/staging_deploy.pub ubuntu@YOUR_HOST
   
   (HOST is configured in factiii.yml → environments.staging.host)
   
   Step 3: Paste the PRIVATE key below (multi-line, end with blank line):
   cat ~/.ssh/staging_deploy`,
    validation: (value) => {
      if (!value || value.trim().length === 0) {
        return { valid: false, error: 'SSH key cannot be empty' };
      }
      if (!value.includes('BEGIN') || !value.includes('PRIVATE KEY')) {
        return { valid: false, error: 'Invalid SSH key format (missing BEGIN/PRIVATE KEY markers)' };
      }
      return { valid: true };
    }
  },
  
  PROD_SSH: {
    type: 'ssh_key',
    description: 'SSH private key for accessing production server',
    helpText: `
   Step 1: Generate a new SSH key pair:
   ssh-keygen -t ed25519 -C "production-deploy" -f ~/.ssh/prod_deploy
   
   Step 2: Add PUBLIC key to your production server:
   ssh-copy-id -i ~/.ssh/prod_deploy.pub ubuntu@YOUR_HOST
   
   (HOST is configured in factiii.yml → environments.production.host)
   
   Step 3: Paste the PRIVATE key below (multi-line, end with blank line):
   cat ~/.ssh/prod_deploy`,
    validation: (value) => {
      if (!value || value.trim().length === 0) {
        return { valid: false, error: 'SSH key cannot be empty' };
      }
      if (!value.includes('BEGIN') || !value.includes('PRIVATE KEY')) {
        return { valid: false, error: 'Invalid SSH key format (missing BEGIN/PRIVATE KEY markers)' };
      }
      return { valid: true };
    }
  },
  
  AWS_SECRET_ACCESS_KEY: {
    type: 'aws_secret',
    description: 'AWS Secret Access Key (the only secret AWS value)',
    helpText: `
   Get from AWS Console: IAM → Users → Security credentials
   
   This is shown only once when you create the key.
   If lost, you must create a new key pair.
   
   Note: AWS_ACCESS_KEY_ID and AWS_REGION go in factiii.yml (not secrets)
   
   Enter AWS Secret Access Key:`,
    validation: (value) => {
      if (!value || value.trim().length === 0) {
        return { valid: false, error: 'AWS Secret Access Key cannot be empty' };
      }
      if (value.length !== 40) {
        return { valid: false, error: 'AWS Secret Access Key should be 40 characters long' };
      }
      return { valid: true };
    }
  }
};

/**
 * Get secret metadata
 */
function getSecretMetadata(secretName) {
  return SECRET_METADATA[secretName] || {
    type: 'generic',
    description: `GitHub secret: ${secretName}`,
    helpText: `\n   Enter value for ${secretName}:`,
    validation: (value) => {
      if (!value || value.trim().length === 0) {
        return { valid: false, error: 'Value cannot be empty' };
      }
      return { valid: true };
    }
  };
}

/**
 * Format help text for a secret
 */
function formatSecretHelp(secretName) {
  const metadata = getSecretMetadata(secretName);
  return `\n🔑 ${secretName}\n\n   ${metadata.description}${metadata.helpText}`;
}

/**
 * Validate secret format
 */
function validateSecretFormat(secretName, value) {
  const metadata = getSecretMetadata(secretName);
  return metadata.validation(value);
}

/**
 * Prompt for single-line input
 */
function promptSingleLine(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Prompt for multi-line input (for SSH keys)
 */
function promptMultiLine(prompt) {
  return new Promise((resolve) => {
    console.log(prompt);
    
    const lines = [];
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });
    
    // Set stdin to raw mode to detect blank lines
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    
    rl.on('line', (line) => {
      // Empty line signals end of input
      if (line.trim() === '' && lines.length > 0) {
        rl.close();
        resolve(lines.join('\n'));
      } else {
        lines.push(line);
      }
    });
    
    rl.on('close', () => {
      if (lines.length > 0) {
        resolve(lines.join('\n'));
      } else {
        resolve('');
      }
    });
  });
}

/**
 * Prompt for a secret with validation
 * @param {string} secretName - Name of the secret
 * @param {object} config - Factiii configuration (optional)
 * @returns {Promise<string>} - Secret value
 */
async function promptForSecret(secretName, config = {}) {
  const metadata = getSecretMetadata(secretName);
  
  // Show help text
  console.log(formatSecretHelp(secretName));
  
  let value;
  let isValid = false;
  let attempts = 0;
  const maxAttempts = 3;
  
  while (!isValid && attempts < maxAttempts) {
    attempts++;
    
    // Prompt based on type
    if (metadata.type === 'ssh_key') {
      value = await promptMultiLine('');
    } else {
      value = await promptSingleLine('   > ');
    }
    
    // Validate
    const validation = validateSecretFormat(secretName, value);
    
    if (validation.valid) {
      isValid = true;
      // Use default value if provided
      if (validation.defaultValue && (!value || value.trim().length === 0)) {
        value = validation.defaultValue;
        console.log(`   Using default: ${value}`);
      }
      console.log('   ✅ Valid input\n');
    } else {
      console.error(`   ❌ ${validation.error}`);
      if (attempts < maxAttempts) {
        console.log(`   Please try again (${attempts}/${maxAttempts})...\n`);
      } else {
        console.error('   Maximum attempts reached. Exiting.\n');
        process.exit(1);
      }
    }
  }
  
  return value;
}

/**
 * Prompt for confirmation (yes/no)
 */
async function confirm(message, defaultYes = true) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    const prompt = defaultYes ? `${message} (Y/n) ` : `${message} (y/N) `;
    
    rl.question(prompt, (answer) => {
      rl.close();
      
      const normalized = answer.trim().toLowerCase();
      
      if (normalized === '') {
        resolve(defaultYes);
      } else if (normalized === 'y' || normalized === 'yes') {
        resolve(true);
      } else if (normalized === 'n' || normalized === 'no') {
        resolve(false);
      } else {
        // Invalid input, use default
        resolve(defaultYes);
      }
    });
  });
}

/**
 * Multi-select prompt (simplified version)
 * In a real implementation, you'd use a library like 'inquirer'
 * For now, this is a basic implementation
 */
async function multiSelect(message, choices) {
  console.log(`\n${message}`);
  console.log('   (Enter numbers separated by spaces, or "all" for all missing)\n');
  
  // Display choices with numbers
  choices.forEach((choice, index) => {
    const status = choice.checked ? '❌ missing' : '✅ exists';
    console.log(`   ${index + 1}. ${choice.name} (${status})`);
  });
  
  const answer = await promptSingleLine('\n   Select: ');
  
  // Handle "all" or "missing"
  if (answer.toLowerCase() === 'all') {
    return choices.map(c => c.name);
  }
  
  if (answer.toLowerCase() === 'missing') {
    return choices.filter(c => c.checked).map(c => c.name);
  }
  
  // Parse numbers
  const selected = [];
  const numbers = answer.split(/[\s,]+/).map(n => parseInt(n.trim()));
  
  for (const num of numbers) {
    if (num > 0 && num <= choices.length) {
      selected.push(choices[num - 1].name);
    }
  }
  
  return selected;
}

module.exports = {
  getSecretMetadata,
  formatSecretHelp,
  validateSecretFormat,
  promptForSecret,
  confirm,
  multiSelect,
  promptSingleLine,
  promptMultiLine
};
