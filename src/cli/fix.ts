/**
 * Fix Command
 *
 * Runs auto-fixes for detected problems
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

import { scan } from './scan.js';
import type { FactiiiConfig, FixOptions, FixResult } from '../types/index.js';

/**
 * Load config from factiii.yml
 */
function loadConfig(rootDir: string): FactiiiConfig {
  const configPath = path.join(rootDir, 'factiii.yml');

  if (!fs.existsSync(configPath)) {
    return {} as FactiiiConfig;
  }

  try {
    return (yaml.load(fs.readFileSync(configPath, 'utf8')) as FactiiiConfig) ?? ({} as FactiiiConfig);
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.error(`⚠️  Error parsing factiii.yml: ${errorMessage}`);
    return {} as FactiiiConfig;
  }
}

export async function fix(options: FixOptions = {}): Promise<FixResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const config = loadConfig(rootDir);

  console.log('🔧 Running auto-fixes...\n');

  // First run scan to get problems
  const problems = await scan({ ...options, silent: true });

  const result: FixResult = {
    fixed: 0,
    manual: 0,
    failed: 0,
    fixes: [],
  };

  // Run fixes for each stage
  for (const stage of ['dev', 'secrets', 'staging', 'prod'] as const) {
    const stageProblems = problems[stage] ?? [];

    for (const problem of stageProblems) {
      if (problem.fix) {
        try {
          const success = await problem.fix(config, rootDir);
          if (success) {
            console.log(`   ✅ Fixed: ${problem.description}`);
            result.fixed++;
            result.fixes.push({ id: problem.id, stage, status: 'fixed' });
          } else {
            console.log(`   ❌ Failed to fix: ${problem.description}`);
            result.failed++;
            result.fixes.push({ id: problem.id, stage, status: 'failed' });
          }
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          console.log(`   ❌ Error fixing ${problem.id}: ${errorMessage}`);
          result.failed++;
          result.fixes.push({ id: problem.id, stage, status: 'failed', error: errorMessage });
        }
      } else {
        console.log(`   📝 Manual fix required: ${problem.description}`);
        console.log(`      ${problem.manualFix}`);
        result.manual++;
        result.fixes.push({ id: problem.id, stage, status: 'manual' });
      }
    }
  }

  console.log('');
  console.log('─'.repeat(60));
  console.log(`Fixed: ${result.fixed}, Manual: ${result.manual}, Failed: ${result.failed}`);

  return result;
}

export default fix;

