const readline = require('readline');

/**
 * Secret metadata with help text and validation
 */
const SECRET_METADATA = {
  STAGING_SSH: {
    type: 'ssh_key',
    description: 'SSH private key for accessing staging server',
    helpText: `
   Step 1: Generate a new SSH key pair:
   ssh-keygen -t ed25519 -C "staging-deploy" -f ~/.ssh/staging_deploy
   
   Step 2: Add PUBLIC key to your staging server (replace YOUR_USER and YOUR_HOST):
   ssh-copy-id -i ~/.ssh/staging_deploy.pub YOUR_USER@YOUR_HOST
   
   Or manually:
   cat ~/.ssh/staging_deploy.pub | ssh YOUR_USER@YOUR_HOST "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
   
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
   
   Step 2: Add PUBLIC key to your production server (replace YOUR_USER and YOUR_HOST):
   ssh-copy-id -i ~/.ssh/prod_deploy.pub YOUR_USER@YOUR_HOST
   
   Or manually:
   cat ~/.ssh/prod_deploy.pub | ssh YOUR_USER@YOUR_HOST "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
   
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
  
  STAGING_HOST: {
    type: 'hostname',
    description: 'Hostname or IP address of staging server',
    helpText: `
   Examples:
   - staging.example.com
   - 192.168.1.100
   - ec2-xx-xx-xx-xx.compute-1.amazonaws.com
   
   Enter staging server hostname or IP:`,
    validation: (value) => {
      if (!value || value.trim().length === 0) {
        return { valid: false, error: 'Hostname cannot be empty' };
      }
      // Basic validation - not empty and no spaces
      if (value.includes(' ')) {
        return { valid: false, error: 'Hostname cannot contain spaces' };
      }
      return { valid: true };
    }
  },
  
  PROD_HOST: {
    type: 'hostname',
    description: 'Hostname or IP address of production server',
    helpText: `
   Examples:
   - production.example.com
   - 192.168.1.200
   - ec2-xx-xx-xx-xx.compute-1.amazonaws.com
   
   Enter production server hostname or IP:`,
    validation: (value) => {
      if (!value || value.trim().length === 0) {
        return { valid: false, error: 'Hostname cannot be empty' };
      }
      if (value.includes(' ')) {
        return { valid: false, error: 'Hostname cannot contain spaces' };
      }
      return { valid: true };
    }
  },
  
  STAGING_USER: {
    type: 'username',
    description: 'SSH username for staging server',
    helpText: `
   Common usernames: ubuntu, admin, deploy, ec2-user
   
   Enter SSH username for staging server (default: ubuntu):`,
    validation: (value) => {
      // Allow empty (will default to ubuntu)
      if (!value || value.trim().length === 0) {
        return { valid: true, defaultValue: 'ubuntu' };
      }
      if (value.includes(' ')) {
        return { valid: false, error: 'Username cannot contain spaces' };
      }
      return { valid: true };
    }
  },
  
  PROD_USER: {
    type: 'username',
    description: 'SSH username for production server',
    helpText: `
   Common usernames: ubuntu, admin, deploy, ec2-user
   
   Enter SSH username for production server (default: ubuntu):`,
    validation: (value) => {
      // Allow empty (will default to ubuntu)
      if (!value || value.trim().length === 0) {
        return { valid: true, defaultValue: 'ubuntu' };
      }
      if (value.includes(' ')) {
        return { valid: false, error: 'Username cannot contain spaces' };
      }
      return { valid: true };
    }
  },
  
  AWS_ACCESS_KEY_ID: {
    type: 'aws_key',
    description: 'AWS Access Key ID for ECR (Docker registry)',
    helpText: `
   Get from AWS Console: IAM → Users → Security credentials
   
   Requirements:
   - Permissions: ecr:GetAuthorizationToken, ecr:BatchGetImage, ecr:PushImage
   - Format: AKIA followed by 16 characters
   
   Enter AWS Access Key ID:`,
    validation: (value) => {
      if (!value || value.trim().length === 0) {
        return { valid: false, error: 'AWS Access Key ID cannot be empty' };
      }
      if (!value.startsWith('AKIA')) {
        return { valid: false, error: 'AWS Access Key ID should start with AKIA' };
      }
      if (value.length !== 20) {
        return { valid: false, error: 'AWS Access Key ID should be 20 characters long' };
      }
      return { valid: true };
    }
  },
  
  AWS_SECRET_ACCESS_KEY: {
    type: 'aws_secret',
    description: 'AWS Secret Access Key for ECR',
    helpText: `
   Get from AWS Console: IAM → Users → Security credentials
   
   This is shown only once when you create the key.
   If lost, you must create a new key pair.
   
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
  },
  
  AWS_REGION: {
    type: 'aws_region',
    description: 'AWS Region where your ECR repository is located',
    helpText: `
   Common regions:
   - us-east-1 (N. Virginia)
   - us-west-2 (Oregon)
   - eu-west-1 (Ireland)
   - ap-southeast-1 (Singapore)
   
   Enter AWS region:`,
    validation: (value) => {
      if (!value || value.trim().length === 0) {
        return { valid: false, error: 'AWS region cannot be empty' };
      }
      // Basic region format check
      if (!/^[a-z]{2}-[a-z]+-\d+$/.test(value)) {
        return { valid: false, error: 'Invalid AWS region format (e.g., us-east-1)' };
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
 * @param {object} config - Core configuration (optional)
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
