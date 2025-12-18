/**
 * Init Command
 *
 * Initializes factiii.yml in a project
 */


import { generateFactiiiYml } from '../generators/generate-factiii-yml.js';
import { generateFactiiiAuto } from '../generators/generate-factiii-auto.js';
import type { InitOptions } from '../types/index.js';

export async function init(options: InitOptions = {}): Promise<void> {
  const rootDir = options.rootDir ?? process.cwd();

  console.log('🚀 Initializing Factiii Stack...\n');

  // Generate factiii.yml
  const created = generateFactiiiYml(rootDir, { force: options.force });

  if (created) {
    // Generate factiiiAuto.yml
    await generateFactiiiAuto(rootDir);
  }
}

export default init;

