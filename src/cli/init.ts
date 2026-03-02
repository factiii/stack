/**
 * Init Command
 *
 * Scans the codebase and creates stack.yml with auto-detected settings
 * and EXAMPLE_ placeholder values for the user to fill in.
 *
 * This command only initializes config files — it does not fix anything.
 * Vault setup, secrets, and all other fixes are handled by scanfixes
 * in the factiii pipeline (run: npx stack scan / npx stack fix).
 */

import * as fs from 'fs';
import { STACK_CONFIG_FILENAME, getStackConfigPath } from '../constants/config-files.js';
import { generateSmartStackYml } from '../generators/generate-stack-yml.js';
import { generateFactiiiAuto } from '../generators/generate-stack-auto.js';
import type { InitOptions } from '../types/index.js';

export async function init(options: InitOptions = {}): Promise<void> {
  const rootDir = options.rootDir ?? process.cwd();
  const configPath = getStackConfigPath(rootDir);
  const isFirstRun = !fs.existsSync(configPath);

  if (options.force) {
    console.log('Regenerating ' + STACK_CONFIG_FILENAME + '...\n');
    generateSmartStackYml(rootDir, { force: true });
    await generateFactiiiAuto(rootDir, { force: true });
  } else if (isFirstRun) {
    console.log('Scanning codebase...\n');
    const created = generateSmartStackYml(rootDir);
    if (created) {
      await generateFactiiiAuto(rootDir);
      console.log('');
      console.log('  ' + STACK_CONFIG_FILENAME + ' is the configuration for everything.');
      console.log('  Update the vars marked with EXAMPLE_ before proceeding.');
      console.log('');
    }
  } else {
    console.log('[OK] ' + STACK_CONFIG_FILENAME + ' already exists');
    console.log('     (use --force to regenerate)\n');
  }

  console.log('  ────────────────────────────────────────────────');
  console.log('  NEXT STEPS');
  console.log('  ────────────────────────────────────────────────');
  console.log('');
  console.log('  1. Replace all EXAMPLE_ values in ' + STACK_CONFIG_FILENAME);
  console.log('  2. npx stack scan           -> check what needs fixing');
  console.log('  3. npx stack fix            -> auto-fix issues');
  console.log('  4. npx stack deploy --secrets set  -> store SSH keys & credentials');
  console.log('');
}

export default init;
