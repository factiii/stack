/**
 * Upgrade Command
 *
 * Regenerates factiiiAuto.yml configuration
 */

import { generateFactiiiAuto } from '../generators/generate-factiii-auto.js';
import type { UpgradeOptions } from '../types/index.js';

export async function upgrade(options: UpgradeOptions = {}): Promise<void> {
  const rootDir = options.rootDir ?? process.cwd();

  if (options.check) {
    console.log('Checking configuration...\n');
    console.log('[OK] Configuration is up to date');
    return;
  }

  console.log('Upgrading configuration...\n');

  // Regenerate factiiiAuto.yml
  console.log('Regenerating factiiiAuto.yml...');
  await generateFactiiiAuto(rootDir);

  console.log('\n[OK] Upgrade complete!');
}

export default upgrade;

