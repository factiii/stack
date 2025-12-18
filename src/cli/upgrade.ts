/**
 * Upgrade Command
 *
 * Upgrades factiii configuration
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

import { generateFactiiiAuto } from '../generators/generate-factiii-auto.js';
import { migrateConfig } from '../utils/config-migrations.js';
import { CURRENT_VERSION } from '../utils/config-schema.js';
import type { FactiiiConfig, UpgradeOptions } from '../types/index.js';

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

export async function upgrade(options: UpgradeOptions = {}): Promise<void> {
  const rootDir = options.rootDir ?? process.cwd();
  const config = loadConfig(rootDir);

  if (options.check) {
    console.log('🔍 Checking for available upgrades...\n');

    const currentVersion = config.config_version ?? '1.0.0';
    console.log(`   Current version: ${currentVersion}`);
    console.log(`   Latest version: ${CURRENT_VERSION}`);

    if (currentVersion === CURRENT_VERSION) {
      console.log('\n✅ Configuration is up to date');
    } else {
      console.log('\n📦 Upgrade available');
      console.log('   Run: npx factiii upgrade');
    }
    return;
  }

  console.log('📦 Upgrading configuration...\n');

  // Migrate config
  const result = migrateConfig(config, null, CURRENT_VERSION);

  if (!result.success) {
    console.log(`❌ Migration failed: ${result.errors.join(', ')}`);
    return;
  }

  if (result.migrationsApplied.length === 0) {
    console.log('✅ Configuration already at latest version');
  } else {
    // Write updated config
    const configPath = path.join(rootDir, 'factiii.yml');
    fs.writeFileSync(configPath, yaml.dump(result.config, { lineWidth: -1 }));

    console.log('✅ Applied migrations:');
    for (const migration of result.migrationsApplied) {
      console.log(`   • ${migration.description}`);
    }
  }

  // Regenerate factiiiAuto.yml
  console.log('\n🔄 Regenerating factiiiAuto.yml...');
  await generateFactiiiAuto(rootDir);

  console.log('\n✅ Upgrade complete!');
}

export default upgrade;

