/**
 * Config file names used across the stack.
 * Single source of truth for stack.yml and stackAuto.yml.
 */

/** User-editable stack config (was factiii.yml) */
export const STACK_CONFIG_FILENAME = 'stack.yml';

/** Auto-detected config (was factiiiAuto.yml) */
export const STACK_AUTO_FILENAME = 'stackAuto.yml';

/** Local machine config (gitignored, per-developer) */
export const STACK_LOCAL_FILENAME = 'stack.local.yml';

import * as path from 'path';
import * as fs from 'fs';

/**
 * Resolve path to main config file. Prefers stack.yml, falls back to factiii.yml for backward compatibility.
 */
export function getStackConfigPath(rootDir: string): string {
  const primary = path.join(rootDir, STACK_CONFIG_FILENAME);
  if (fs.existsSync(primary)) return primary;
  const legacy = path.join(rootDir, 'factiii.yml');
  if (fs.existsSync(legacy)) return legacy;
  return primary; // default to new name for writing
}

/**
 * Resolve path to auto config file. Prefers stackAuto.yml, falls back to factiiiAuto.yml for backward compatibility.
 */
export function getStackAutoPath(rootDir: string): string {
  const primary = path.join(rootDir, STACK_AUTO_FILENAME);
  if (fs.existsSync(primary)) return primary;
  const legacy = path.join(rootDir, 'factiiiAuto.yml');
  if (fs.existsSync(legacy)) return legacy;
  return primary;
}

/**
 * Resolve path to local config file. Prefers stack.local.yml, falls back to factiii.local.yml.
 */
export function getStackLocalPath(rootDir: string): string {
  const primary = path.join(rootDir, STACK_LOCAL_FILENAME);
  if (fs.existsSync(primary)) return primary;
  const legacy = path.join(rootDir, 'factiii.local.yml');
  if (fs.existsSync(legacy)) return legacy;
  return primary;
}
