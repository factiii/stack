/**
 * Config Writer Utility
 *
 * Updates values in stack.yml while preserving formatting.
 * Used by fixes that need to write back discovered values (e.g., Elastic IP → prod.domain).
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { getStackConfigPath } from '../constants/config-files.js';
import type { FactiiiConfig } from '../types/index.js';

/**
 * Update a nested value in stack.yml (or legacy factiii.yml)
 *
 * @param rootDir - Project root directory
 * @param keyPath - Dot-separated path (e.g., 'prod.domain')
 * @param value - New value to set
 * @returns true if updated successfully
 */
export function updateConfigValue(rootDir: string, keyPath: string, value: string): boolean {
  const configPath = getStackConfigPath(rootDir);

  if (!fs.existsSync(configPath)) {
    return false;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const config = (yaml.load(content) as Record<string, unknown>) ?? {};

    // Navigate to the parent and set the value
    const keys = keyPath.split('.');
    const lastKey = keys.pop();
    if (!lastKey) return false;

    let current: Record<string, unknown> = config;
    for (const key of keys) {
      if (!current[key] || typeof current[key] !== 'object') {
        current[key] = {};
      }
      current = current[key] as Record<string, unknown>;
    }

    const oldValue = current[lastKey];
    current[lastKey] = value;

    // Write back
    const newContent = yaml.dump(config, {
      lineWidth: -1,
      noRefs: true,
      quotingType: "'",
      forceQuotes: false,
    });
    fs.writeFileSync(configPath, newContent, 'utf8');

    console.log('   Updated config: ' + keyPath + ' = ' + value + (oldValue ? ' (was: ' + oldValue + ')' : ''));
    return true;
  } catch (e) {
    console.log('   [!] Failed to update config: ' + (e instanceof Error ? e.message : String(e)));
    return false;
  }
}
