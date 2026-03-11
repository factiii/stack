/**
 * Auth Addon Plugin
 *
 * Thin delegation layer for @factiii/auth.
 * Scanfix logic lives in the @factiii/auth package — stack loads and
 * runs those fixes at runtime via resolveAuthPlugin().
 *
 * When @factiii/auth exports a `stackPlugin` object with a `fixes` array,
 * those fixes are used. Otherwise, falls back to inline scanfixes.
 *
 * ============================================================
 * PLUGIN STRUCTURE
 * ============================================================
 *
 * **scanfix/** - Fallback scan/fix operations (used when @factiii/auth
 *   does not yet export stackPlugin)
 *   - setup.ts   - Dev stage: package check, init, doctor, migrate
 *   - secrets.ts - Secrets stage: JWT_SECRET, OAuth keys
 *   - validate.ts - Staging/Prod: env var validation
 *
 * **index.ts** - This file (thin loader)
 *   - resolveAuthPlugin() - dynamically loads fixes from @factiii/auth
 *   - shouldLoad() - auto-detects @factiii/auth in project
 *   - Falls back to inline scanfixes if @factiii/auth doesn't export plugin
 * ============================================================
 */

import * as fs from 'fs';
import * as path from 'path';
import type { FactiiiConfig, Fix, ServerOS, ExternalPluginExport } from '../../../types/index.js';

// Inline fallback scanfixes (used when @factiii/auth doesn't export stackPlugin)
import { setupFixes } from './scanfix/setup.js';
import { secretsFixes } from './scanfix/secrets.js';
import { validateFixes } from './scanfix/validate.js';

/**
 * Try to load scanfixes from @factiii/auth's stackPlugin export.
 * Returns the exported fixes if available, null otherwise.
 */
function resolveAuthPlugin(): ExternalPluginExport | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const authPkg = require('@factiii/auth');
    if (authPkg.stackPlugin && Array.isArray(authPkg.stackPlugin.fixes)) {
      return authPkg.stackPlugin as ExternalPluginExport;
    }
  } catch {
    // @factiii/auth not installed or doesn't export stackPlugin
  }
  return null;
}

/**
 * Get fixes — prefer @factiii/auth's exported fixes, fall back to inline.
 */
function loadFixes(): Fix[] {
  const external = resolveAuthPlugin();
  if (external) {
    return external.fixes;
  }
  // Fallback: use inline scanfixes from this repo
  return [...setupFixes, ...secretsFixes, ...validateFixes];
}

class AuthAddon {
  // ============================================================
  // STATIC METADATA
  // ============================================================

  static readonly id = 'auth';
  static readonly name = 'Auth (@factiii/auth)';
  static readonly category: 'addon' = 'addon';
  static readonly version = '1.0.0';

  /**
   * Compatible with all server types (auth is app-level, not OS-specific)
   */
  static readonly compatibleServers: ServerOS[] = ['mac', 'ubuntu', 'windows'];

  static readonly defaultServer: ServerOS = 'ubuntu';

  // Env vars this plugin requires (auto-generates .env.example checks)
  static readonly requiredEnvVars: string[] = ['JWT_SECRET'];

  // Schema for stack.yml (user-editable, optional)
  static readonly configSchema: Record<string, unknown> = {
    auth: {
      features: {
        oauth: false,
        twoFa: false,
        emailVerification: false,
      },
      oauth_provider: 'EXAMPLE_google',
    },
  };

  // Schema for stackAuto.yml (auto-detected)
  static readonly autoConfigSchema: Record<string, string> = {
    auth_installed: 'boolean',
    auth_initialized: 'boolean',
  };

  /**
   * Auto-detect @factiii/auth in package.json dependencies.
   * No manual config needed — plugin loads automatically.
   */
  static async shouldLoad(rootDir: string, _config: FactiiiConfig): Promise<boolean> {
    try {
      const pkgPath = path.join(rootDir, 'package.json');
      if (!fs.existsSync(pkgPath)) return false;

      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      return !!deps['@factiii/auth'];
    } catch {
      return false;
    }
  }

  static helpText: Record<string, string> = {
    JWT_SECRET: `
   JWT signing secret for @factiii/auth.

   This is auto-generated (256-bit random) when you run:
     npx stack fix --secrets

   The secret is stored in Ansible Vault and used to sign
   authentication tokens (JWT) for your application.`,
  };

  // ============================================================
  // FIXES - Loaded from @factiii/auth when available, inline fallback otherwise
  // ============================================================

  static readonly fixes: Fix[] = loadFixes();

  // ============================================================
  // STATIC HELPER METHODS
  // ============================================================

  /**
   * Auto-detect auth configuration
   */
  static async detectConfig(rootDir: string): Promise<Record<string, unknown>> {
    const detected: Record<string, unknown> = {};

    try {
      const pkgPath = path.join(rootDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        detected.auth_installed = !!deps['@factiii/auth'];
      }
    } catch {
      detected.auth_installed = false;
    }

    // Check if auth models exist in Prisma schema
    try {
      const schemaPath = path.join(rootDir, 'prisma', 'schema.prisma');
      if (fs.existsSync(schemaPath)) {
        const content = fs.readFileSync(schemaPath, 'utf8');
        detected.auth_initialized = content.includes('model User') && content.includes('model Session');
      } else {
        detected.auth_initialized = false;
      }
    } catch {
      detected.auth_initialized = false;
    }

    return detected;
  }

  // ============================================================
  // INSTANCE
  // ============================================================

  private _config: FactiiiConfig;

  constructor(config: FactiiiConfig) {
    this._config = config;
  }
}

export default AuthAddon;
