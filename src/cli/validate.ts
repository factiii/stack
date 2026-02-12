/**
 * Validate Command (Legacy)
 *
 * Validates configuration files
 */

import { scan } from './scan.js';
import type { ValidateOptions } from '../types/index.js';

export async function validate(_options: ValidateOptions = {}): Promise<boolean> {
  console.log('[!] The validate command is deprecated. Use: npx factiii scan\n');

  const problems = await scan({ rootDir: process.cwd() });

  const totalProblems =
    problems.dev.length +
    problems.secrets.length +
    problems.staging.length +
    problems.prod.length;

  return totalProblems === 0;
}

export default validate;

