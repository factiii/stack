/**
 * Version Check Utilities
 *
 * Utilities for checking and comparing package versions.
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

import { getStackAutoPath } from '../constants/config-files.js';

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

interface FactiiiAutoVersion {
  factiii_version: string | null;
  factiii_min_version: string | null;
}

interface VersionCompatibility {
  compatible: boolean;
  currentVersion: string;
  configVersion: string | null;
  minVersion: string | null;
  needsUpgrade: boolean;
  isBreaking: boolean;
  message: string;
}

/**
 * Get current Factiii package version
 */
export function getFactiiiVersion(): string {
  try {
    const packageJsonPath = path.join(__dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '1.0.0';
  } catch {
    return '1.0.0';
  }
}

/**
 * Parse semantic version string
 * @param version - Version string (e.g., "1.2.3")
 */
export function parseVersion(version: string): ParsedVersion | null {
  if (!version) return null;

  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;

  return {
    major: parseInt(match[1] ?? '0', 10),
    minor: parseInt(match[2] ?? '0', 10),
    patch: parseInt(match[3] ?? '0', 10),
  };
}

/**
 * Compare two versions
 * @param a - First version
 * @param b - Second version
 * @returns Negative if a < b, 0 if equal, positive if a > b
 */
export function compareVersions(a: string, b: string): number {
  const vA = parseVersion(a);
  const vB = parseVersion(b);

  if (!vA || !vB) return 0;

  if (vA.major !== vB.major) return vA.major - vB.major;
  if (vA.minor !== vB.minor) return vA.minor - vB.minor;
  return vA.patch - vB.patch;
}

/**
 * Check if version a is compatible with minimum version b
 * @param current - Current version
 * @param minimum - Minimum required version
 */
export function isCompatible(current: string, minimum: string): boolean {
  return compareVersions(current, minimum) >= 0;
}

/**
 * Check if upgrade from a to b is a breaking change (major version bump)
 * @param from - Original version
 * @param to - Target version
 */
export function isBreakingUpgrade(from: string, to: string): boolean {
  const vFrom = parseVersion(from);
  const vTo = parseVersion(to);

  if (!vFrom || !vTo) return false;
  return vTo.major > vFrom.major;
}

/**
 * Read version info from stackAuto.yml (or legacy factiiiAuto.yml)
 * @param rootDir - Project root directory
 */
export function readFactiiiAutoVersion(rootDir: string): FactiiiAutoVersion {
  const autoPath = getStackAutoPath(rootDir);

  if (!fs.existsSync(autoPath)) {
    return { factiii_version: null, factiii_min_version: null };
  }

  try {
    const content = fs.readFileSync(autoPath, 'utf8');
    const config = yaml.load(content) as {
      factiii_version?: string;
      factiii_min_version?: string;
    } | null;
    return {
      factiii_version: config?.factiii_version ?? null,
      factiii_min_version: config?.factiii_min_version ?? null,
    };
  } catch {
    return { factiii_version: null, factiii_min_version: null };
  }
}

/**
 * Check version compatibility and return status
 * @param rootDir - Project root directory
 */
export function checkVersionCompatibility(rootDir: string): VersionCompatibility {
  const currentVersion = getFactiiiVersion();
  const { factiii_version, factiii_min_version } = readFactiiiAutoVersion(rootDir);

  const result: VersionCompatibility = {
    compatible: true,
    currentVersion,
    configVersion: factiii_version,
    minVersion: factiii_min_version,
    needsUpgrade: false,
    isBreaking: false,
    message: '',
  };

  // No version info in stackAuto.yml (legacy or first run)
  if (!factiii_version) {
    result.needsUpgrade = true;
    result.message = 'No version info in stackAuto.yml. Run: npx factiii upgrade';
    return result;
  }

  // Check if current version meets minimum requirement
  if (factiii_min_version && !isCompatible(currentVersion, factiii_min_version)) {
    result.compatible = false;
    result.message = `Factiii version ${currentVersion} is below minimum required ${factiii_min_version}`;
    return result;
  }

  // Check if versions match
  if (compareVersions(currentVersion, factiii_version) !== 0) {
    result.needsUpgrade = true;
    result.isBreaking = isBreakingUpgrade(factiii_version, currentVersion);

    if (result.isBreaking) {
      result.message = `Major version change: ${factiii_version} → ${currentVersion}. Run: npx factiii upgrade`;
    } else {
      result.message = `Version mismatch: config=${factiii_version}, installed=${currentVersion}. Run: npx factiii upgrade`;
    }
    return result;
  }

  result.message = 'Version compatible';
  return result;
}

/**
 * Display version warning if needed
 * @param rootDir - Project root directory
 * @returns True if warning was displayed
 */
export function displayVersionWarning(rootDir: string): boolean {
  const status = checkVersionCompatibility(rootDir);

  if (!status.compatible) {
    console.log('');
    console.log('[!] VERSION INCOMPATIBILITY');
    console.log(`   ${status.message}`);
    console.log('');
    return true;
  }

  if (status.needsUpgrade) {
    console.log('');
    console.log('Version Update Available');
    console.log(`   ${status.message}`);
    if (status.isBreaking) {
      console.log('  [!] This is a major version change - check CHANGELOG.md');
    }
    console.log('');
    return true;
  }

  return false;
}

