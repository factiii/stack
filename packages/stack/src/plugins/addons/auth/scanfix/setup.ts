/**
 * Auth Setup Scanfixes (Dev Stage)
 *
 * Thin delegation layer — all auth logic lives in @factiii/auth.
 * Stack only handles:
 *   1. Ensuring @factiii/auth is in package.json
 *   2. Calling `npx @factiii/auth doctor` for everything else
 *
 * The doctor command in @factiii/auth handles init, schema checks,
 * migrations, and any other auth-specific validations.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';

/**
 * Detect the package manager used in the project
 */
function detectPackageManager(rootDir: string): 'pnpm' | 'npm' | 'yarn' {
  if (fs.existsSync(path.join(rootDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(rootDir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/**
 * Run a command silently and return success/failure
 */
function runSilent(cmd: string, rootDir: string): { success: boolean; output: string } {
  try {
    const output = execSync(cmd, {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true, output };
  } catch (e) {
    const output = e instanceof Error ? e.message : String(e);
    return { success: false, output };
  }
}

export const setupFixes: Fix[] = [
  {
    id: 'auth-package-missing',
    stage: 'dev',
    severity: 'critical',
    description: '@factiii/auth missing from package.json dependencies',
    scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      try {
        const pkgPath = path.join(rootDir, 'package.json');
        if (!fs.existsSync(pkgPath)) return false;

        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        return !deps['@factiii/auth'];
      } catch {
        return false;
      }
    },
    fix: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      try {
        const pm = detectPackageManager(rootDir);
        const installCmd = pm === 'pnpm' ? 'pnpm add @factiii/auth'
          : pm === 'yarn' ? 'yarn add @factiii/auth'
          : 'npm install @factiii/auth';

        console.log('   Running: ' + installCmd);
        execSync(installCmd, {
          cwd: rootDir,
          stdio: 'inherit',
        });

        // Verify
        const pkgPath = path.join(rootDir, 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        return !!deps['@factiii/auth'];
      } catch (e) {
        console.log('   Failed: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Run: pnpm add @factiii/auth (or npm install @factiii/auth)',
  },

  {
    id: 'auth-doctor',
    stage: 'dev',
    severity: 'critical',
    description: '@factiii/auth doctor check failed',
    scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      // Delegate to @factiii/auth doctor — it handles all checks
      // (init, schema, migrations, config, etc.)
      const result = runSilent('npx @factiii/auth doctor', rootDir);
      return !result.success;
    },
    fix: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      // Run doctor with visible output — it handles all fixes
      try {
        execSync('npx @factiii/auth doctor', {
          cwd: rootDir,
          stdio: 'inherit',
        });
        return true;
      } catch {
        console.log('   Doctor found issues — review output above');
        return false;
      }
    },
    manualFix: 'Run: npx @factiii/auth doctor',
  },
];
