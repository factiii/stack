/**
 * Init Command
 *
 * Initializes factiii.yml in a project
 */

import * as path from 'path';
import * as fs from 'fs';
import { generateFactiiiYml } from '../generators/generate-factiii-yml.js';
import { generateFactiiiAuto } from '../generators/generate-factiii-auto.js';
import { confirm } from '../utils/secret-prompts.js';
import type { InitOptions } from '../types/index.js';

export async function init(options: InitOptions = {}): Promise<void> {
  const rootDir = options.rootDir ?? process.cwd();

  console.log('🚀 Initializing Factiii Stack...\n');

  const factiiiYmlPath = path.join(rootDir, 'factiii.yml');
  const factiiiAutoYmlPath = path.join(rootDir, 'factiiiAuto.yml');

  // Check if files exist and prompt if not using --force
  let shouldOverwriteYml = options.force ?? false;
  let shouldOverwriteAuto = options.force ?? false;

  if (fs.existsSync(factiiiYmlPath) && !options.force) {
    shouldOverwriteYml = await confirm('factiii.yml already exists. Overwrite it?', false);
    if (!shouldOverwriteYml) {
      console.log('⏭️  Skipping factiii.yml');
    }
  }

  if (fs.existsSync(factiiiAutoYmlPath) && !options.force) {
    shouldOverwriteAuto = await confirm('factiiiAuto.yml already exists. Overwrite it?', false);
    if (!shouldOverwriteAuto) {
      console.log('⏭️  Skipping factiiiAuto.yml');
    }
  }

  // Generate factiii.yml
  if (shouldOverwriteYml) {
    const created = generateFactiiiYml(rootDir, { force: true });
    if (created) {
      // Generate factiiiAuto.yml (always update if yml was created/updated)
      await generateFactiiiAuto(rootDir, { force: shouldOverwriteAuto });
    }
  } else {
    // factiii.yml not overwritten, but check if we should update factiiiAuto.yml
    if (shouldOverwriteAuto) {
      await generateFactiiiAuto(rootDir, { force: true });
    } else if (fs.existsSync(factiiiYmlPath)) {
      // factiii.yml exists and wasn't overwritten, but auto might need updating
      // (factiiiAuto.yml is auto-detected, so update if content changed)
      await generateFactiiiAuto(rootDir, { force: false });
    } else {
      console.log('\n⏭️  No configuration files to create.');
    }
  }
}

export default init;

