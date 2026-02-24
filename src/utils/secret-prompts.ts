/**
 * Secret Prompts
 *
 * Interactive prompts for collecting secrets from the user.
 */

import * as readline from 'readline';

import type { FactiiiConfig } from '../types/index.js';

interface ValidationResult {
  valid: boolean;
  error?: string;
  defaultValue?: string;
}

interface SecretMetadata {
  type: string;
  description: string;
  helpText: string;
  validation: (value: string) => ValidationResult;
}

interface MultiSelectChoice {
  name: string;
  checked: boolean;
}

/**
 * Secret metadata with help text and validation
 *
 * Simplified secrets (per architecture):
 * - {ENV}_SSH: SSH private key for each environment
 * - AWS_SECRET_ACCESS_KEY: Only truly secret AWS value
 *
 * Not secrets (in stack.yml):
 * - HOST: environments.{env}.host
 * - AWS_ACCESS_KEY_ID: aws.access_key_id
 * - AWS_REGION: aws.region
 */
const SECRET_METADATA: Record<string, SecretMetadata> = {
  STAGING_SSH: {
    type: 'ssh_key',
    description: 'SSH private key for accessing staging server',
    helpText: `
   Step 1: Generate a new SSH key pair:
   ssh-keygen -t ed25519 -C "staging-deploy" -f ~/.ssh/staging_deploy
   
   Step 2: Add PUBLIC key to your staging server:
   ssh-copy-id -i ~/.ssh/staging_deploy.pub ubuntu@YOUR_HOST
   
   (HOST is configured in stack.yml → environments.staging.host)
   
   Step 3: Paste the PRIVATE key below (multi-line, end with blank line):
   cat ~/.ssh/staging_deploy`,
    validation: (value: string): ValidationResult => {
      if (!value || value.trim().length === 0) {
        return { valid: false, error: 'SSH key cannot be empty' };
      }
      if (!value.includes('BEGIN') || !value.includes('PRIVATE KEY')) {
        return {
          valid: false,
          error: 'Invalid SSH key format (missing BEGIN/PRIVATE KEY markers)',
        };
      }
      return { valid: true };
    },
  },

  PROD_SSH: {
    type: 'ssh_key',
    description: 'SSH private key for accessing production server',
    helpText: `
   Step 1: Generate a new SSH key pair:
   ssh-keygen -t ed25519 -C "production-deploy" -f ~/.ssh/prod_deploy
   
   Step 2: Add PUBLIC key to your production server:
   ssh-copy-id -i ~/.ssh/prod_deploy.pub ubuntu@YOUR_HOST
   
   (HOST is configured in stack.yml → environments.production.host)
   
   Step 3: Paste the PRIVATE key below (multi-line, end with blank line):
   cat ~/.ssh/prod_deploy`,
    validation: (value: string): ValidationResult => {
      if (!value || value.trim().length === 0) {
        return { valid: false, error: 'SSH key cannot be empty' };
      }
      if (!value.includes('BEGIN') || !value.includes('PRIVATE KEY')) {
        return {
          valid: false,
          error: 'Invalid SSH key format (missing BEGIN/PRIVATE KEY markers)',
        };
      }
      return { valid: true };
    },
  },

  AWS_SECRET_ACCESS_KEY: {
    type: 'aws_secret',
    description: 'AWS Secret Access Key (the only secret AWS value)',
    helpText: `
   Get from AWS Console: IAM → Users → Security credentials
   
   This is shown only once when you create the key.
   If lost, you must create a new key pair.
   
   Note: AWS_ACCESS_KEY_ID and AWS_REGION go in stack.yml (not secrets)
   
   Enter AWS Secret Access Key:`,
    validation: (value: string): ValidationResult => {
      if (!value || value.trim().length === 0) {
        return { valid: false, error: 'AWS Secret Access Key cannot be empty' };
      }
      if (value.length !== 40) {
        return {
          valid: false,
          error: 'AWS Secret Access Key should be 40 characters long',
        };
      }
      return { valid: true };
    },
  },
};

/**
 * Get secret metadata
 */
export function getSecretMetadata(secretName: string): SecretMetadata {
  return (
    SECRET_METADATA[secretName] ?? {
      type: 'generic',
      description: `GitHub secret: ${secretName}`,
      helpText: `\n   Enter value for ${secretName}:`,
      validation: (value: string): ValidationResult => {
        if (!value || value.trim().length === 0) {
          return { valid: false, error: 'Value cannot be empty' };
        }
        return { valid: true };
      },
    }
  );
}

/**
 * Format help text for a secret
 */
export function formatSecretHelp(secretName: string): string {
  const metadata = getSecretMetadata(secretName);
  return `\n${secretName}\n\n   ${metadata.description}${metadata.helpText}`;
}

/**
 * Validate secret format
 */
export function validateSecretFormat(
  secretName: string,
  value: string
): ValidationResult {
  const metadata = getSecretMetadata(secretName);
  return metadata.validation(value);
}

/**
 * Prompt for single-line input
 */
export function promptSingleLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
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
export function promptMultiLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    console.log(prompt);

    const lines: string[] = [];
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
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
 * @param secretName - Name of the secret
 * @param _config - Factiii configuration (optional)
 * @returns Secret value
 */
export async function promptForSecret(
  secretName: string,
  _config: FactiiiConfig = {} as FactiiiConfig
): Promise<string> {
  const metadata = getSecretMetadata(secretName);

  // Show help text
  console.log(formatSecretHelp(secretName));

  let value = '';
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
      console.log('   [OK] Valid input\n');
    } else {
      console.error(`   [ERROR] ${validation.error}`);
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
export async function confirm(
  message: string,
  defaultYes: boolean = true
): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
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
export async function multiSelect(
  message: string,
  choices: MultiSelectChoice[]
): Promise<string[]> {
  console.log(`\n${message}`);
  console.log('   (Enter numbers separated by spaces, or "all" for all missing)\n');

  // Display choices with numbers
  choices.forEach((choice, index) => {
    const status = choice.checked ? '[!] missing' : '[OK] exists';
    console.log(`   ${index + 1}. ${choice.name} (${status})`);
  });

  const answer = await promptSingleLine('\n   Select: ');

  // Handle "all" or "missing"
  if (answer.toLowerCase() === 'all') {
    return choices.map((c) => c.name);
  }

  if (answer.toLowerCase() === 'missing') {
    return choices.filter((c) => c.checked).map((c) => c.name);
  }

  // Parse numbers
  const selected: string[] = [];
  const numbers = answer.split(/[\s,]+/).map((n) => parseInt(n.trim()));

  for (const num of numbers) {
    if (num > 0 && num <= choices.length) {
      const choice = choices[num - 1];
      if (choice) {
        selected.push(choice.name);
      }
    }
  }

  return selected;
}

/**
 * Prompt for an environment secret (simpler than SSH keys)
 * @param name - Name of the environment variable
 * @param stage - Stage (staging or prod)
 * @returns Secret value
 */
export async function promptForEnvSecret(
  name: string,
  stage: 'staging' | 'prod'
): Promise<string> {
  console.log(`\nSetting ${name} for ${stage}`);
  console.log(`   Enter the value for this environment variable.`);
  console.log(`   (This will be stored in Ansible Vault and deployed to the server)\n`);

  let value = '';
  let isValid = false;
  let attempts = 0;
  const maxAttempts = 3;

  while (!isValid && attempts < maxAttempts) {
    attempts++;

    value = await promptSingleLine('   > ');

    if (value && value.trim().length > 0) {
      isValid = true;
      console.log('   [OK] Value set\n');
    } else {
      console.error('   [ERROR] Value cannot be empty');
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


