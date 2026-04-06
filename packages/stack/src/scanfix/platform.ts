/**
 * Platform Detection
 *
 * Detects the current operating system platform for scanfix commands.
 */

import { execSync } from 'child_process';
import type { Platform } from './types.js';

/**
 * Detect the current platform
 *
 * @returns Platform identifier ('mac', 'ubuntu', 'windows')
 */
export function detectPlatform(): Platform {
  const platform = process.platform;

  if (platform === 'darwin') {
    return 'mac';
  }

  if (platform === 'linux') {
    // Check for apt (Debian/Ubuntu)
    try {
      execSync('which apt-get', { stdio: 'pipe' });
      return 'ubuntu';
    } catch {
      // Could add yum/dnf detection for RHEL in future
      // Default to ubuntu for now
      return 'ubuntu';
    }
  }

  if (platform === 'win32') {
    return 'windows';
  }

  // Default to ubuntu for unknown platforms
  return 'ubuntu';
}

/**
 * Check if current platform matches expected
 *
 * @param expected The platform to check for
 * @returns true if current platform matches
 */
export function isPlatform(expected: Platform): boolean {
  return detectPlatform() === expected;
}
