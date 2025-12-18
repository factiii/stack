/**
 * Config Migration System
 *
 * Handles migrations between factiii.yml schema versions.
 * Each migration is idempotent and preserves existing user values.
 */

import { semverLt, compareVersions } from './config-schema.js';
import type { FactiiiConfig } from '../types/index.js';

interface MigrationApplied {
  id: string;
  description: string;
  from: string;
  to: string;
}

interface MigrationResult {
  success: boolean;
  originalVersion: string;
  targetVersion: string;
  migrationsApplied: MigrationApplied[];
  config: FactiiiConfig;
  errors: string[];
  message?: string;
}

interface Migration {
  id: string;
  fromVersion: string;
  toVersion: string;
  description: string;
  migrate: (config: FactiiiConfig) => FactiiiConfig;
}

// Migration definitions
export const MIGRATIONS: Record<string, Migration> = {
  '1.0.0_to_1.1.0': {
    id: '1.0.0_to_1.1.0',
    fromVersion: '1.0.0',
    toVersion: '1.1.0',
    description: 'Add config_version field and per-environment ssh_user support',

    /**
     * Migrate config from 1.0.0 to 1.1.0
     */
    migrate: (config: FactiiiConfig): FactiiiConfig => {
      // Add config_version field at the top
      const migratedConfig: FactiiiConfig = {
        config_version: '1.1.0',
        ...config,
      };

      // Note: We don't auto-add ssh_user to environments
      // That's an optional field that users can add manually
      // The schema validator will inform them it's available

      return migratedConfig;
    },
  },
};

/**
 * Get ordered list of migrations needed to go from one version to another
 * @param fromVersion - Starting version
 * @param toVersion - Target version
 * @returns Ordered array of migration objects
 */
export function getMigrationPath(fromVersion: string, toVersion: string): Migration[] {
  const path: Migration[] = [];

  // Build migration path
  // For now, we only have one migration, but this supports chaining
  if (semverLt(fromVersion, '1.1.0') && compareVersions(toVersion, '1.1.0') >= 0) {
    const migration = MIGRATIONS['1.0.0_to_1.1.0'];
    if (migration) {
      path.push(migration);
    }
  }

  // Future migrations would be added here in order
  // Example:
  // if (semverLt(fromVersion, '1.2.0') && compareVersions(toVersion, '1.2.0') >= 0) {
  //   path.push(MIGRATIONS['1.1.0_to_1.2.0']);
  // }

  return path;
}

/**
 * Apply migrations to config
 * @param config - Config object to migrate
 * @param fromVersion - Starting version (defaults to config.config_version or '1.0.0')
 * @param toVersion - Target version
 * @returns Result object with migrated config and migration info
 */
export function migrateConfig(
  config: FactiiiConfig,
  fromVersion: string | null = null,
  toVersion: string
): MigrationResult {
  const startVersion = fromVersion ?? config.config_version ?? '1.0.0';

  const result: MigrationResult = {
    success: true,
    originalVersion: startVersion,
    targetVersion: toVersion,
    migrationsApplied: [],
    config: { ...config },
    errors: [],
  };

  // If already at target version, no migration needed
  if (compareVersions(startVersion, toVersion) >= 0) {
    result.success = true;
    result.message = 'Config already at target version';
    return result;
  }

  // Get migration path
  const migrations = getMigrationPath(startVersion, toVersion);

  if (migrations.length === 0) {
    result.success = false;
    result.errors.push(`No migration path found from ${startVersion} to ${toVersion}`);
    return result;
  }

  // Apply migrations in order
  let currentConfig: FactiiiConfig = { ...config };

  for (const migration of migrations) {
    try {
      currentConfig = migration.migrate(currentConfig);
      result.migrationsApplied.push({
        id: migration.id,
        description: migration.description,
        from: migration.fromVersion,
        to: migration.toVersion,
      });
    } catch (error) {
      result.success = false;
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.errors.push(`Migration ${migration.id} failed: ${errorMessage}`);
      return result;
    }
  }

  result.config = currentConfig;
  result.message = `Successfully migrated from ${startVersion} to ${toVersion}`;

  return result;
}

/**
 * Check if a migration is available
 * @param migrationId - Migration ID to check
 */
export function hasMigration(migrationId: string): boolean {
  return migrationId in MIGRATIONS;
}

/**
 * Get migration details
 * @param migrationId - Migration ID
 * @returns Migration object or null if not found
 */
export function getMigration(migrationId: string): Migration | null {
  return MIGRATIONS[migrationId] ?? null;
}

