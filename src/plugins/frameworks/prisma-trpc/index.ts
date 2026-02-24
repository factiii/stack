/**
 * Prisma + tRPC Framework Plugin
 *
 * Handles Prisma database and tRPC API server detection, validation,
 * and deployment (migrations, etc.).
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import yaml from 'js-yaml';

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

  // Schema for stack.yml (user-editable)
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
    {
      id: 'env-example-staging-format',
      stage: 'dev',
      severity: 'warning',
      description: '.env.example and .env.staging should use postgres:5432 format (container format) and match each other',
      scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        const hasPrisma = await PrismaTrpcPlugin.hasPrisma(rootDir);
        if (!hasPrisma) return false;

        const examplePath = path.join(rootDir, '.env.example');
        const stagingPath = path.join(rootDir, '.env.staging');

        // Check if .env.example exists
        if (!fs.existsSync(examplePath)) {
          return false; // Missing .env.example is handled by another fix
        }

        // Parse .env.example
        const exampleContent = fs.readFileSync(examplePath, 'utf8');
        const exampleDbUrlMatch = exampleContent.match(/^DATABASE_URL=(.+)$/m);
        const exampleTestDbUrlMatch = exampleContent.match(/^TEST_DATABASE_URL=(.+)$/m);

        // Check if .env.example uses postgres:5432 format
        const exampleUsesContainerFormat =
          exampleDbUrlMatch?.[1]?.includes('@postgres:5432/') ?? false;
        const exampleTestUsesContainerFormat =
          exampleTestDbUrlMatch?.[1]?.includes('@postgres:5432/') ?? false;

        if (!exampleUsesContainerFormat) {
          return true; // .env.example doesn't use container format
        }

        // Check if .env.staging exists
        if (!fs.existsSync(stagingPath)) {
          return false; // Missing .env.staging is handled by another fix
        }

        // Parse .env.staging
        const stagingContent = fs.readFileSync(stagingPath, 'utf8');
        const stagingDbUrlMatch = stagingContent.match(/^DATABASE_URL=(.+)$/m);
        const stagingTestDbUrlMatch = stagingContent.match(/^TEST_DATABASE_URL=(.+)$/m);

        // Check if .env.staging uses postgres:5432 format
        const stagingUsesContainerFormat =
          stagingDbUrlMatch?.[1]?.includes('@postgres:5432/') ?? false;
        const stagingTestUsesContainerFormat =
          stagingTestDbUrlMatch?.[1]?.includes('@postgres:5432/') ?? false;

        if (!stagingUsesContainerFormat) {
          return true; // .env.staging doesn't use container format
        }

        // Check if they match (compare the URLs, ignoring host/port differences if one is container format)
        // Extract the database name and credentials for comparison
        const extractDbInfo = (url: string): string | null => {
          try {
            const urlObj = new URL(url);
            return `${urlObj.username}:${urlObj.password}@${urlObj.pathname}`;
          } catch {
            return null;
          }
        };

        const exampleDbInfo = exampleDbUrlMatch?.[1]
          ? extractDbInfo(exampleDbUrlMatch[1])
          : null;
        const stagingDbInfo = stagingDbUrlMatch?.[1]
          ? extractDbInfo(stagingDbUrlMatch[1])
          : null;

        if (exampleDbInfo && stagingDbInfo && exampleDbInfo !== stagingDbInfo) {
          return true; // They don't match
        }

        // Check TEST_DATABASE_URL if both exist
        if (exampleTestDbUrlMatch?.[1] && stagingTestDbUrlMatch?.[1]) {
          const exampleTestDbInfo = extractDbInfo(exampleTestDbUrlMatch[1]);
          const stagingTestDbInfo = extractDbInfo(stagingTestDbUrlMatch[1]);
          if (exampleTestDbInfo && stagingTestDbInfo && exampleTestDbInfo !== stagingTestDbInfo) {
            return true; // They don't match
          }
        }

        // Check for port conflicts when on staging server
        const isOnStagingServer = process.env.GITHUB_ACTIONS === 'true';
        if (isOnStagingServer) {
          const hasConflict = await PrismaTrpcPlugin.checkPortConflicts(rootDir, config);
          if (hasConflict) {
            return true; // Port conflict detected
          }
        }

        return false; // All checks passed
      },
      fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        const examplePath = path.join(rootDir, '.env.example');
        const stagingPath = path.join(rootDir, '.env.staging');

        if (!fs.existsSync(examplePath)) {
          return false;
        }

        // Read .env.example
        let exampleContent = fs.readFileSync(examplePath, 'utf8');

        // Update DATABASE_URL to use postgres:5432 format if it doesn't
        exampleContent = exampleContent.replace(
          /^DATABASE_URL=(.+)$/m,
          (match, url: string) => {
            try {
              const urlObj = new URL(url);
              // Replace localhost:PORT or any host:PORT with postgres:5432
              const newUrl = url.replace(/@[^:]+:\d+\//, '@postgres:5432/');
              return `DATABASE_URL=${newUrl}`;
            } catch {
              return match; // Keep original if parsing fails
            }
          }
        );

        // Update TEST_DATABASE_URL similarly
        exampleContent = exampleContent.replace(
          /^TEST_DATABASE_URL=(.+)$/m,
          (match, url: string) => {
            try {
              const urlObj = new URL(url);
              const newUrl = url.replace(/@[^:]+:\d+\//, '@postgres:5432/');
              return `TEST_DATABASE_URL=${newUrl}`;
            } catch {
              return match;
            }
          }
        );

        fs.writeFileSync(examplePath, exampleContent);

        // Update .env.staging to match if it exists
        if (fs.existsSync(stagingPath)) {
          let stagingContent = fs.readFileSync(stagingPath, 'utf8');

          // Extract database info from example
          const exampleDbUrlMatch = exampleContent.match(/^DATABASE_URL=(.+)$/m);
          if (exampleDbUrlMatch?.[1]) {
            const exampleUrl = exampleDbUrlMatch[1];
            try {
              const urlObj = new URL(exampleUrl);
              const newStagingUrl = `postgresql://${urlObj.username}:${urlObj.password}@postgres:5432${urlObj.pathname}${urlObj.search}`;
              stagingContent = stagingContent.replace(/^DATABASE_URL=(.+)$/m, `DATABASE_URL=${newStagingUrl}`);
            } catch {
              // Keep original if parsing fails
            }
          }

          // Update TEST_DATABASE_URL similarly
          const exampleTestDbUrlMatch = exampleContent.match(/^TEST_DATABASE_URL=(.+)$/m);
          if (exampleTestDbUrlMatch?.[1]) {
            const exampleTestUrl = exampleTestDbUrlMatch[1];
            try {
              const urlObj = new URL(exampleTestUrl);
              const newStagingTestUrl = `postgresql://${urlObj.username}:${urlObj.password}@postgres:5432${urlObj.pathname}${urlObj.search}`;
              stagingContent = stagingContent.replace(/^TEST_DATABASE_URL=(.+)$/m, `TEST_DATABASE_URL=${newStagingTestUrl}`);
            } catch {
              // Keep original if parsing fails
            }
          }

          fs.writeFileSync(stagingPath, stagingContent);
          console.log('   Updated .env.example and .env.staging to use postgres:5432 format');
        } else {
          console.log('   Updated .env.example to use postgres:5432 format');
        }

        return true;
      },
      manualFix:
        'Update .env.example and .env.staging to use postgres:5432 format (container format). They should match each other.',
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

  /**
   * Check for port conflicts across repos in staging
   * Returns true if a conflict is detected (will throw error in scan)
   */
  static async checkPortConflicts(
    rootDir: string,
    config: FactiiiConfig
  ): Promise<boolean> {
    // Only check when on staging server
    const isOnStagingServer = process.env.GITHUB_ACTIONS === 'true';
    if (!isOnStagingServer) {
      return false;
    }

    // Import scanRepos from generate-all
    // Use dynamic import to avoid circular dependencies
    const generateAllModule = await import('../../../scripts/generate-all.js');
    const scanRepos = generateAllModule.scanRepos;
    if (!scanRepos) {
      return false; // Can't check if scanRepos not available
    }
    const repos = scanRepos();

    const factiiiDir = process.env.FACTIII_DIR ?? path.join(process.env.HOME ?? '/Users/jon', '.factiii');
    const composePath = path.join(factiiiDir, 'docker-compose.yml');

    // Collect all exposed ports from existing postgres services
    const usedPorts = new Map<number, string>(); // port -> repo name

    if (fs.existsSync(composePath)) {
      try {
        const composeContent = fs.readFileSync(composePath, 'utf8');
        const compose = yaml.load(composeContent) as {
          services?: Record<
            string,
            {
              ports?: string[];
              [key: string]: unknown;
            }
          >;
          [key: string]: unknown;
        };

        if (compose.services) {
          for (const [serviceName, service] of Object.entries(compose.services)) {
            // Check if this is a postgres service
            if (serviceName === 'postgres' || serviceName.includes('postgres')) {
              if (service.ports && Array.isArray(service.ports)) {
                for (const portMapping of service.ports) {
                  // Parse port mapping like "5438:5432"
                  const match = portMapping.match(/^(\d+):\d+$/);
                  if (match) {
                    const exposedPort = parseInt(match[1]!, 10);
                    // Try to find which repo this belongs to by checking service names
                    for (const repo of repos) {
                      if (serviceName.includes(repo.name)) {
                        usedPorts.set(exposedPort, repo.name);
                        break;
                      }
                    }
                    // If we can't determine repo, still track the port
                    if (!usedPorts.has(exposedPort)) {
                      usedPorts.set(exposedPort, 'unknown');
                    }
                  }
                }
              }
            }
          }
        }
      } catch (error) {
        // If we can't parse docker-compose.yml, skip conflict check
        console.log(`   ⚠️  Could not parse docker-compose.yml for port conflict check: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    }

    // Check current repo's planned port from .env.staging
    const stagingPath = path.join(rootDir, '.env.staging');
    if (!fs.existsSync(stagingPath)) {
      return false; // No .env.staging, can't check
    }

    const stagingContent = fs.readFileSync(stagingPath, 'utf8');
    const dbUrlMatch = stagingContent.match(/^DATABASE_URL=(.+)$/m);
    if (!dbUrlMatch) {
      return false; // No DATABASE_URL, can't check
    }

    const dbUrl = dbUrlMatch[1]!;
    let plannedPort: number | null = null;

    // If DATABASE_URL uses postgres:5432 format, we need to check docker-compose.yml
    // to see what port would be exposed. But if docker-compose.yml doesn't exist yet,
    // we can't determine the port. In that case, we'll skip the check.
    if (dbUrl.includes('@postgres:5432/')) {
      // Container format - check if we can determine exposed port from docker-compose
      // For now, we'll check the current repo's service in docker-compose if it exists
      const currentRepoName = config.name ?? 'app';
      if (fs.existsSync(composePath)) {
        try {
          const composeContent = fs.readFileSync(composePath, 'utf8');
          const compose = yaml.load(composeContent) as {
            services?: Record<
              string,
              {
                ports?: string[];
                [key: string]: unknown;
              }
            >;
            [key: string]: unknown;
          };

          // Look for postgres service
          // Note: There should only be one postgres service in the unified docker-compose.yml
          // but it might be shared or per-repo. For now, check for any postgres service.
          if (compose.services) {
            for (const [serviceName, service] of Object.entries(compose.services)) {
              if (serviceName === 'postgres') {
                if (service.ports && Array.isArray(service.ports)) {
                  for (const portMapping of service.ports) {
                    const match = portMapping.match(/^(\d+):\d+$/);
                    if (match) {
                      plannedPort = parseInt(match[1]!, 10);
                      break;
                    }
                  }
                }
                if (plannedPort) break;
              }
            }
          }
        } catch {
          // Skip if can't parse
        }
      }
      // If we still don't have a planned port, we can't check for conflicts
      // This will be checked after first deploy when docker-compose.yml is generated
      if (!plannedPort) {
        return false;
      }
    } else {
      // Host format (localhost:PORT) - extract port from URL
      try {
        const urlObj = new URL(dbUrl);
        plannedPort = parseInt(urlObj.port || '5432', 10);
      } catch {
        return false; // Can't parse URL
      }
    }

    if (!plannedPort) {
      return false;
    }

    // Check if planned port conflicts with any used port
    if (usedPorts.has(plannedPort)) {
      const conflictingRepo = usedPorts.get(plannedPort);
      const currentRepoName = config.name ?? 'app';
      throw new Error(
        `Port conflict detected: Port ${plannedPort} is already used by ${conflictingRepo === 'unknown' ? 'another repo' : `repo "${conflictingRepo}"`}. ` +
        `Each repo needs a unique port in their .env.staging DATABASE_URL. ` +
        `Update your .env.staging to use a different port (e.g., 5438, 5439, 5440, etc.). ` +
        `This ensures each database container can communicate with its server container properly.`
      );
    }

    return false; // No conflict
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

