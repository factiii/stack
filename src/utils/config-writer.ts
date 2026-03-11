/**
 * Config Writer Utility
 *
 * Updates values in stack.yml while preserving comments and formatting.
 * Uses line-level string replacement instead of yaml.dump() to avoid
 * stripping comments or reformatting the file.
 */

import * as fs from 'fs';
import yaml from 'js-yaml';
import { getStackConfigPath } from '../constants/config-files.js';

/**
 * Update a nested value in stack.yml using line-based replacement.
 * Preserves comments, formatting, and key order.
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
    const keys = keyPath.split('.');

    if (keys.length === 1) {
      // Top-level key: replace "key: oldValue" with "key: newValue"
      const result = replaceYamlValue(content, keys[0]!, 0, value);
      if (result) {
        fs.writeFileSync(configPath, result.content, 'utf8');
        console.log('   Updated config: ' + keyPath + ' = ' + value + (result.oldValue ? ' (was: ' + result.oldValue + ')' : ''));
        return true;
      }
    } else if (keys.length === 2) {
      // Nested key (e.g., prod.domain): find parent section, then replace child
      const parentKey = keys[0]!;
      const childKey = keys[1]!;
      const result = replaceNestedYamlValue(content, parentKey, childKey, value);
      if (result) {
        fs.writeFileSync(configPath, result.content, 'utf8');
        console.log('   Updated config: ' + keyPath + ' = ' + value + (result.oldValue ? ' (was: ' + result.oldValue + ')' : ''));
        return true;
      }
    }

    // Fallback: key not found in file, append it
    // For nested keys, find or create the parent section
    if (keys.length === 2) {
      const parentKey = keys[0]!;
      const childKey = keys[1]!;
      const parentRegex = new RegExp('^' + parentKey + ':\\s*$', 'm');
      if (parentRegex.test(content)) {
        // Parent exists but child key not found — append under parent
        const newContent = content.replace(parentRegex, parentKey + ':\n  ' + childKey + ': ' + value);
        fs.writeFileSync(configPath, newContent, 'utf8');
        console.log('   Updated config: ' + keyPath + ' = ' + value + ' (added)');
        return true;
      }
    }

    console.log('   [!] Could not find key ' + keyPath + ' in ' + configPath);
    return false;
  } catch (e) {
    console.log('   [!] Failed to update config: ' + (e instanceof Error ? e.message : String(e)));
    return false;
  }
}

/**
 * Replace a top-level YAML value using line-based string replacement.
 */
function replaceYamlValue(
  content: string,
  key: string,
  indent: number,
  newValue: string
): { content: string; oldValue: string } | null {
  const prefix = ' '.repeat(indent);
  const regex = new RegExp('^(' + prefix + key + ':\\s*)(.+)$', 'm');
  const match = content.match(regex);
  if (!match) return null;

  const oldValue = match[2]!.trim();
  const newContent = content.replace(regex, '$1' + newValue);
  return { content: newContent, oldValue };
}

/**
 * Replace a nested YAML value (parent.child) using line-based replacement.
 * Finds the parent section, then replaces the child key within it.
 */
function replaceNestedYamlValue(
  content: string,
  parentKey: string,
  childKey: string,
  newValue: string
): { content: string; oldValue: string } | null {
  const lines = content.split('\n');
  let inParent = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Check if this is the parent key (no indentation)
    if (line.match(new RegExp('^' + parentKey + ':'))) {
      inParent = true;
      continue;
    }

    // If we're in the parent section
    if (inParent) {
      // Check if we've left the section (non-indented line that isn't empty/comment)
      if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('#')) {
        inParent = false;
        continue;
      }

      // Check if this is the child key (indented under parent)
      const childMatch = line.match(new RegExp('^(\\s+' + childKey + ':\\s*)(.+)$'));
      if (childMatch) {
        const oldValue = childMatch[2]!.trim();
        lines[i] = childMatch[1] + newValue;
        return { content: lines.join('\n'), oldValue };
      }
    }
  }

  return null;
}
