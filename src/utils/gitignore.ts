/**
 * Gitignore Utilities
 *
 * Shared functions for checking and updating .gitignore entries.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Check if an entry exists in .gitignore
 */
export function isGitignored(rootDir: string, entry: string): boolean {
  const gitignorePath = path.join(rootDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    return false;
  }
  const content = fs.readFileSync(gitignorePath, 'utf8');
  const lines = content.split('\n').map((l) => l.trim());
  return lines.includes(entry);
}

/**
 * Append a line to .gitignore if not already present.
 * Returns true if the entry was added, false if already present.
 */
export function ensureGitignored(rootDir: string, entry: string): boolean {
  if (isGitignored(rootDir, entry)) {
    return false;
  }
  const gitignorePath = path.join(rootDir, '.gitignore');
  let content = '';
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, 'utf8');
  }
  const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(gitignorePath, separator + entry + '\n');
  return true;
}
