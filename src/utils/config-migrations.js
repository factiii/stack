/**
 * Config Migration System
 * 
 * Handles migrations between factiii.yml schema versions.
 * Each migration is idempotent and preserves existing user values.
 */

const { semverLt, compareVersions } = require('./config-schema');

// Migration definitions
const MIGRATIONS = {
  '1.0.0_to_1.1.0': {
    id: '1.0.0_to_1.1.0',
    fromVersion: '1.0.0',
    toVersion: '1.1.0',
    description: 'Add config_version field and per-environment ssh_user support',
    
    /**
     * Migrate config from 1.0.0 to 1.1.0
     * @param {Object} config - Config object to migrate
     * @returns {Object} - Migrated config
     */
    migrate: (config) => {
      // Add config_version field at the top
      const migratedConfig = {
        config_version: '1.1.0',
        ...config
      };
      
      // Note: We don't auto-add ssh_user to environments
      // That's an optional field that users can add manually
      // The schema validator will inform them it's available
      
      return migratedConfig;
    }
  }
};

/**
 * Get ordered list of migrations needed to go from one version to another
 * @param {string} fromVersion - Starting version
 * @param {string} toVersion - Target version
 * @returns {Array} - Ordered array of migration objects
 */
function getMigrationPath(fromVersion, toVersion) {
  const path = [];
  
  // Build migration path
  // For now, we only have one migration, but this supports chaining
  if (semverLt(fromVersion, '1.1.0') && compareVersions(toVersion, '1.1.0') >= 0) {
    path.push(MIGRATIONS['1.0.0_to_1.1.0']);
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
 * @param {Object} config - Config object to migrate
 * @param {string} fromVersion - Starting version (defaults to config.config_version or '1.0.0')
 * @param {string} toVersion - Target version
 * @returns {Object} - Result object with migrated config and migration info
 */
function migrateConfig(config, fromVersion = null, toVersion) {
  const startVersion = fromVersion || config.config_version || '1.0.0';
  
  const result = {
    success: true,
    originalVersion: startVersion,
    targetVersion: toVersion,
    migrationsApplied: [],
    config: { ...config },
    errors: []
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
  let currentConfig = { ...config };
  
  for (const migration of migrations) {
    try {
      currentConfig = migration.migrate(currentConfig);
      result.migrationsApplied.push({
        id: migration.id,
        description: migration.description,
        from: migration.fromVersion,
        to: migration.toVersion
      });
    } catch (error) {
      result.success = false;
      result.errors.push(`Migration ${migration.id} failed: ${error.message}`);
      return result;
    }
  }
  
  result.config = currentConfig;
  result.message = `Successfully migrated from ${startVersion} to ${toVersion}`;
  
  return result;
}

/**
 * Check if a migration is available
 * @param {string} migrationId - Migration ID to check
 * @returns {boolean}
 */
function hasMigration(migrationId) {
  return migrationId in MIGRATIONS;
}

/**
 * Get migration details
 * @param {string} migrationId - Migration ID
 * @returns {Object|null} - Migration object or null if not found
 */
function getMigration(migrationId) {
  return MIGRATIONS[migrationId] || null;
}

module.exports = {
  MIGRATIONS,
  migrateConfig,
  getMigrationPath,
  hasMigration,
  getMigration
};
