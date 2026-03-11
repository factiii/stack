/**
 * Interactive Prompts Utilities
 *
 * Helper functions for prompting users for input interactively.
 */

import * as readline from 'readline';

/**
 * Prompt user for a secret value
 * Returns the secret value (not masked in terminal - use with caution)
 */
export async function promptForSecret(
  secretName: string,
  description?: string
): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const label = description ? description + ' (' + secretName + ')' : secretName;

  return new Promise((resolve) => {
    rl.question('   Enter ' + label + ': ', (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Prompt user for confirmation (y/n)
 */
export async function promptForConfirmation(
  message: string,
  defaultValue = false
): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const suffix = defaultValue ? ' [Y/n]: ' : ' [y/N]: ';

  return new Promise((resolve) => {
    rl.question(message + suffix, (answer: string) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();

      if (normalized === '') {
        resolve(defaultValue);
      } else {
        resolve(normalized === 'y' || normalized === 'yes');
      }
    });
  });
}

/**
 * Prompt user for a string value
 */
export async function promptForString(
  label: string,
  defaultValue?: string
): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const suffix = defaultValue ? ' [' + defaultValue + ']: ' : ': ';

  return new Promise((resolve) => {
    rl.question(label + suffix, (answer: string) => {
      rl.close();
      const value = answer.trim();
      resolve(value || defaultValue || '');
    });
  });
}
