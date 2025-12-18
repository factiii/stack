/**
 * Prisma + tRPC Framework Plugin
 *
 * Handles Prisma database and tRPC API server detection, validation,
 * and deployment (migrations, etc.).
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

import type { FactiiiConfig, Fix, DeployResult } from '../../../types/index.js';

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface DetectedConfig {
  has_prisma: boolean;
  has_trpc: boolean;
  prisma_schema?: string | null;
  prisma_version?: string | null;
}

class PrismaTrpcPlugin {
  // ============================================================
  // STATIC METADATA
  // ============================================================

  static readonly id = 'prisma-trpc';
  static readonly name = 'Prisma + tRPC';
  static readonly category: 'framework' = 'framework';
  static readonly version = '1.0.0';

  // Env vars this plugin requires (will be validated against .env.example)
  static readonly requiredEnvVars: string[] = ['DATABASE_URL'];

  // Schema for factiii.yml (user-editable)
  static readonly configSchema: Record<string, unknown> = {
    prisma: {
      schema_path: null, // Optional override
      version: null, // Optional override
    },
  };

  // Schema for factiiiAuto.yml (auto-detected)
  static readonly autoConfigSchema: Record<string, string> = {
    has_prisma: 'boolean',
    has_trpc: 'boolean',
    prisma_schema: 'string',
    prisma_version: 'string',
  };

  /**
   * Determine if this plugin should be loaded for this project
   * Loads if Prisma or tRPC is detected in package.json
   */
  static async shouldLoad(rootDir: string, _config: FactiiiConfig): Promise<boolean> {
    const pkgPath = path.join(rootDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PackageJson;
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      return !!(
        deps.prisma ||
        deps['@prisma/client'] ||
        deps['@trpc/server'] ||
        deps['@trpc/client']
      );
    } catch {
      return false;
    }
  }

  // ============================================================
  // FIXES - All issues this plugin can detect and resolve
  // ============================================================

  static readonly fixes: Fix[] = [
    // DEV STAGE FIXES
    {
      id: 'missing-prisma',
      stage: 'dev',
      severity: 'info',
      description: 'Prisma not detected in project',
      scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        // Check if prisma is in package.json
        const pkgPath = path.join(rootDir, 'package.json');
        if (!fs.existsSync(pkgPath)) return true;

        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PackageJson;
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          return !deps.prisma && !deps['@prisma/client'];
        } catch {
          return true;
        }
      },
      fix: null,
      manualFix:
        'Install Prisma: npm install -D prisma @prisma/client && npx prisma init',
    },
    {
      id: 'missing-prisma-schema',
      stage: 'dev',
      severity: 'critical',
      description: 'Prisma schema not found',
      scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        // Only check if Prisma is installed
        const hasPrisma = await PrismaTrpcPlugin.hasPrisma(rootDir);
        if (!hasPrisma) return false;

        return !PrismaTrpcPlugin.findPrismaSchema(rootDir);
      },
      fix: null,
      manualFix: 'Run: npx prisma init',
    },
    {
      id: 'missing-env-file',
      stage: 'dev',
      severity: 'warning',
      description: '.env file missing (copy of .env.example)',
      scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        if (!fs.existsSync(path.join(rootDir, '.env.example'))) return false;
        return !fs.existsSync(path.join(rootDir, '.env'));
      },
      fix: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        fs.copyFileSync(path.join(rootDir, '.env.example'), path.join(rootDir, '.env'));
        console.log('   Created .env from .env.example');
        return true;
      },
      manualFix: 'Run: cp .env.example .env',
    },
    {
      id: 'prisma-client-not-generated',
      stage: 'dev',
      severity: 'warning',
      description: 'Prisma client not generated',
      scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        const hasPrisma = await PrismaTrpcPlugin.hasPrisma(rootDir);
        if (!hasPrisma) return false;

        // Check if prisma client exists in node_modules
        const clientPath = path.join(rootDir, 'node_modules', '.prisma', 'client');
        return !fs.existsSync(clientPath);
      },
      fix: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        try {
          execSync('npx prisma generate', { cwd: rootDir, stdio: 'pipe' });
          console.log('   Generated Prisma client');
          return true;
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          console.log(`   Failed: ${errorMessage}`);
          return false;
        }
      },
      manualFix: 'Run: npx prisma generate',
    },
    {
      id: 'pending-migrations-dev',
      stage: 'dev',
      severity: 'warning',
      description: 'Prisma migrations pending locally',
      scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        const hasPrisma = await PrismaTrpcPlugin.hasPrisma(rootDir);
        if (!hasPrisma) return false;

        try {
          const result = execSync('npx prisma migrate status', {
            cwd: rootDir,
            encoding: 'utf8',
            stdio: 'pipe',
          });
          return (
            result.includes('Following migration') || result.includes('not yet applied')
          );
        } catch {
          return false; // Error likely means no database connection
        }
      },
      fix: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        try {
          execSync('npx prisma migrate dev', { cwd: rootDir, stdio: 'inherit' });
          return true;
        } catch {
          return false;
        }
      },
      manualFix: 'Run: npx prisma migrate dev',
    },

    // STAGING STAGE FIXES
    {
      id: 'missing-env-staging',
      stage: 'staging',
      severity: 'critical',
      description: '.env.staging file missing',
      scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        return !fs.existsSync(path.join(rootDir, '.env.staging'));
      },
      fix: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        if (fs.existsSync(path.join(rootDir, '.env.example'))) {
          fs.copyFileSync(
            path.join(rootDir, '.env.example'),
            path.join(rootDir, '.env.staging')
          );
          console.log('   Created .env.staging from .env.example');
          console.log('   ⚠️  Please update values for staging environment');
          return true;
        }
        return false;
      },
      manualFix: 'Create .env.staging with staging database URL',
    },

    // PROD STAGE FIXES
    {
      id: 'missing-env-prod',
      stage: 'prod',
      severity: 'critical',
      description: '.env.prod file missing',
      scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        return !fs.existsSync(path.join(rootDir, '.env.prod'));
      },
      fix: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        if (fs.existsSync(path.join(rootDir, '.env.example'))) {
          fs.copyFileSync(
            path.join(rootDir, '.env.example'),
            path.join(rootDir, '.env.prod')
          );
          console.log('   Created .env.prod from .env.example');
          console.log('   ⚠️  Please update values for production environment');
          return true;
        }
        return false;
      },
      manualFix: 'Create .env.prod with production database URL',
    },
  ];

  // ============================================================
  // STATIC HELPER METHODS
  // ============================================================

  /**
   * Auto-detect Prisma and tRPC configuration
   */
  static async detectConfig(rootDir: string): Promise<DetectedConfig | null> {
    const hasPrisma = await this.hasPrisma(rootDir);
    const hasTrpc = await this.detectTrpc(rootDir);

    if (!hasPrisma && !hasTrpc) return null;

    const config: DetectedConfig = {
      has_prisma: hasPrisma,
      has_trpc: hasTrpc,
    };

    if (hasPrisma) {
      config.prisma_schema = this.findPrismaSchema(rootDir);
      config.prisma_version = this.getPrismaVersion(rootDir);
    }

    return config;
  }

  /**
   * Detect tRPC in the project
   */
  static async detectTrpc(rootDir: string): Promise<boolean> {
    const pkgPath = path.join(rootDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PackageJson;
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      return !!(deps['@trpc/server'] || deps['@trpc/client']);
    } catch {
      return false;
    }
  }

  /**
   * Check if Prisma is installed in the project
   */
  static async hasPrisma(rootDir: string): Promise<boolean> {
    const pkgPath = path.join(rootDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PackageJson;
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      return !!(deps.prisma || deps['@prisma/client']);
    } catch {
      return false;
    }
  }

  /**
   * Find Prisma schema file
   */
  static findPrismaSchema(rootDir: string): string | null {
    const commonPaths = [
      'prisma/schema.prisma',
      'apps/server/prisma/schema.prisma',
      'packages/server/prisma/schema.prisma',
      'backend/prisma/schema.prisma',
      'server/prisma/schema.prisma',
    ];

    for (const relativePath of commonPaths) {
      const fullPath = path.join(rootDir, relativePath);
      if (fs.existsSync(fullPath)) {
        return relativePath;
      }
    }

    return null;
  }

  /**
   * Get Prisma version from package.json
   */
  static getPrismaVersion(rootDir: string): string | null {
    const pkgPath = path.join(rootDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return null;

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PackageJson;
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const version = deps.prisma ?? deps['@prisma/client'];
      return version ? version.replace(/^[\^~]/, '') : null;
    } catch {
      return null;
    }
  }

  // ============================================================
  // INSTANCE METHODS
  // ============================================================

  private _config: FactiiiConfig;

  constructor(config: FactiiiConfig) {
    this._config = config;
  }

  /**
   * Deploy - run migrations for the environment
   */
  async deploy(_config: FactiiiConfig, environment: string): Promise<DeployResult> {
    const rootDir = process.cwd();

    if (!(await PrismaTrpcPlugin.hasPrisma(rootDir))) {
      return { success: true, message: 'Prisma not detected, skipping' };
    }

    console.log(`   📦 Running Prisma migrations for ${environment}...`);

    try {
      if (environment === 'dev') {
        execSync('npx prisma migrate dev', { stdio: 'inherit' });
      } else {
        // For staging/prod, use migrate deploy (non-interactive)
        execSync('npx prisma migrate deploy', { stdio: 'inherit' });
      }

      return { success: true, message: 'Migrations complete' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Undeploy - nothing to do for Prisma
   */
  async undeploy(_config: FactiiiConfig, _environment: string): Promise<DeployResult> {
    return { success: true, message: 'Nothing to undeploy for Prisma' };
  }
}

export default PrismaTrpcPlugin;

