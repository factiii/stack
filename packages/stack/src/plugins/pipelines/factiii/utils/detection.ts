/**
 * Configuration Detection Utilities
 * 
 * Static methods for detecting project configuration:
 * - Package manager (pnpm, yarn, npm)
 * - Node.js version
 * - pnpm version
 * - Dockerfile location
 */

import * as fs from 'fs';
import * as path from 'path';

interface PackageJson {
  engines?: {
    node?: string;
    pnpm?: string;
  };
  packageManager?: string;
}

export interface DetectedConfig {
  package_manager: string;
  node_version: string | null;
  pnpm_version: string | null;
  dockerfile: string | null;
}

/**
 * Auto-detect pipeline configuration
 */
export function detectConfig(rootDir: string): DetectedConfig {
  return {
    package_manager: detectPackageManager(rootDir),
    node_version: detectNodeVersion(rootDir),
    pnpm_version: detectPnpmVersion(rootDir),
    dockerfile: findDockerfile(rootDir),
  };
}

/**
 * Detect package manager
 */
export function detectPackageManager(rootDir: string): string {
  if (fs.existsSync(path.join(rootDir, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (fs.existsSync(path.join(rootDir, 'yarn.lock'))) {
    return 'yarn';
  }
  if (fs.existsSync(path.join(rootDir, 'package-lock.json'))) {
    return 'npm';
  }
  return 'npm';
}

/**
 * Detect Node.js version from package.json
 */
export function detectNodeVersion(rootDir: string): string | null {
  const packageJsonPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJson;
    if (pkg?.engines?.node) {
      const cleaned = pkg.engines.node.replace(/[^0-9.]/g, '');
      return cleaned || null;
    }
  } catch {
    // Ignore errors
  }

  return null;
}

/**
 * Detect pnpm version from package.json
 */
export function detectPnpmVersion(rootDir: string): string | null {
  const packageJsonPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJson;

    if (pkg?.packageManager?.startsWith('pnpm@')) {
      const version = pkg.packageManager.split('@')[1];
      return version?.split('.')[0] ?? null;
    }

    if (pkg?.engines?.pnpm) {
      const cleaned = pkg.engines.pnpm.replace(/[^0-9.]/g, '');
      return cleaned.split('.')[0] ?? null;
    }
  } catch {
    // Ignore errors
  }

  return null;
}

/**
 * Find Dockerfile
 */
export function findDockerfile(rootDir: string): string | null {
  const commonPaths = [
    'Dockerfile',
    'apps/server/Dockerfile',
    'packages/server/Dockerfile',
    'backend/Dockerfile',
    'server/Dockerfile',
  ];

  for (const relativePath of commonPaths) {
    if (fs.existsSync(path.join(rootDir, relativePath))) {
      return relativePath;
    }
  }

  return null;
}

