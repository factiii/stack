/**
 * Check Config Command (Legacy)
 *
 * Checks configuration for an environment
 */

import { scan } from './scan.js';
import type { CheckConfigOptions, Stage } from '../types/index.js';

export async function checkConfig(options: CheckConfigOptions = {}): Promise<boolean> {
  console.log('[!] The check-config command is deprecated. Use: npx stack scan\n');

  const environment = options.environment ?? 'staging';
  const stages: Stage[] = [environment as Stage];

  const problems = await scan({ rootDir: process.cwd(), stages });

  const envProblems = problems[environment as keyof typeof problems] ?? [];
  return envProblems.length === 0;
}

export default checkConfig;

