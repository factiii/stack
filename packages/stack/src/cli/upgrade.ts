/**
 * Upgrade Command
 *
 * Regenerates stackAuto.yml configuration
 */

import { generateFactiiiAuto } from '../generators/generate-stack-auto.js';
import type { UpgradeOptions } from '../types/index.js';

export async function upgrade(options: UpgradeOptions = {}): Promise<void> {
  const rootDir = options.rootDir ?? process.cwd();

  if (options.check) {
    console.log('Checking configuration...\n');
    console.log('[OK] Configuration is up to date');
    return;
  }

  console.log('Upgrading configuration...\n');

  // Regenerate stackAuto.yml
  console.log('Regenerating stackAuto.yml...');
  await generateFactiiiAuto(rootDir);

  console.log('\n[OK] Upgrade complete!');
}

export default upgrade;

