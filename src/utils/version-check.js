const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Get current Core package version
 */
function getCoreVersion() {
  try {
    const packageJsonPath = path.join(__dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return pkg.version || '1.0.0';
  } catch (e) {
    return '1.0.0';
  }
}

/**
 * Parse semantic version string
 * @param {string} version - Version string (e.g., "1.2.3")
 * @returns {{major: number, minor: number, patch: number} | null}
 */
function parseVersion(version) {
  if (!version) return null;
  
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10)
  };
}

/**
 * Compare two versions
 * @param {string} a - First version
 * @param {string} b - Second version
 * @returns {number} - Negative if a < b, 0 if equal, positive if a > b
 */
function compareVersions(a, b) {
  const vA = parseVersion(a);
  const vB = parseVersion(b);
  
  if (!vA || !vB) return 0;
  
  if (vA.major !== vB.major) return vA.major - vB.major;
  if (vA.minor !== vB.minor) return vA.minor - vB.minor;
  return vA.patch - vB.patch;
}

/**
 * Check if version a is compatible with minimum version b
 * @param {string} current - Current version
 * @param {string} minimum - Minimum required version
 * @returns {boolean}
 */
function isCompatible(current, minimum) {
  return compareVersions(current, minimum) >= 0;
}

/**
 * Check if upgrade from a to b is a breaking change (major version bump)
 * @param {string} from - Original version
 * @param {string} to - Target version
 * @returns {boolean}
 */
function isBreakingUpgrade(from, to) {
  const vFrom = parseVersion(from);
  const vTo = parseVersion(to);
  
  if (!vFrom || !vTo) return false;
  return vTo.major > vFrom.major;
}

/**
 * Read version info from coreAuto.yml
 * @param {string} rootDir - Project root directory
 * @returns {{core_version: string|null, core_min_version: string|null}}
 */
function readCoreAutoVersion(rootDir) {
  const coreAutoPath = path.join(rootDir, 'coreAuto.yml');
  
  if (!fs.existsSync(coreAutoPath)) {
    return { core_version: null, core_min_version: null };
  }
  
  try {
    const content = fs.readFileSync(coreAutoPath, 'utf8');
    const config = yaml.load(content);
    return {
      core_version: config.core_version || null,
      core_min_version: config.core_min_version || null
    };
  } catch (e) {
    return { core_version: null, core_min_version: null };
  }
}

/**
 * Check version compatibility and return status
 * @param {string} rootDir - Project root directory
 * @returns {{
 *   compatible: boolean,
 *   currentVersion: string,
 *   configVersion: string|null,
 *   minVersion: string|null,
 *   needsUpgrade: boolean,
 *   isBreaking: boolean,
 *   message: string
 * }}
 */
function checkVersionCompatibility(rootDir) {
  const currentVersion = getCoreVersion();
  const { core_version, core_min_version } = readCoreAutoVersion(rootDir);
  
  const result = {
    compatible: true,
    currentVersion,
    configVersion: core_version,
    minVersion: core_min_version,
    needsUpgrade: false,
    isBreaking: false,
    message: ''
  };
  
  // No version info in coreAuto.yml (legacy or first run)
  if (!core_version) {
    result.needsUpgrade = true;
    result.message = 'No version info in coreAuto.yml. Run: npx core upgrade';
    return result;
  }
  
  // Check if current version meets minimum requirement
  if (core_min_version && !isCompatible(currentVersion, core_min_version)) {
    result.compatible = false;
    result.message = `Core version ${currentVersion} is below minimum required ${core_min_version}`;
    return result;
  }
  
  // Check if versions match
  if (compareVersions(currentVersion, core_version) !== 0) {
    result.needsUpgrade = true;
    result.isBreaking = isBreakingUpgrade(core_version, currentVersion);
    
    if (result.isBreaking) {
      result.message = `Major version change: ${core_version} → ${currentVersion}. Run: npx core upgrade`;
    } else {
      result.message = `Version mismatch: config=${core_version}, installed=${currentVersion}. Run: npx core upgrade`;
    }
    return result;
  }
  
  result.message = 'Version compatible';
  return result;
}

/**
 * Display version warning if needed
 * @param {string} rootDir - Project root directory
 * @returns {boolean} - True if warning was displayed
 */
function displayVersionWarning(rootDir) {
  const status = checkVersionCompatibility(rootDir);
  
  if (!status.compatible) {
    console.log('');
    console.log('⚠️  VERSION INCOMPATIBILITY');
    console.log(`   ${status.message}`);
    console.log('');
    return true;
  }
  
  if (status.needsUpgrade) {
    console.log('');
    console.log('ℹ️  Version Update Available');
    console.log(`   ${status.message}`);
    if (status.isBreaking) {
      console.log('   ⚠️  This is a major version change - check CHANGELOG.md');
    }
    console.log('');
    return true;
  }
  
  return false;
}

module.exports = {
  getCoreVersion,
  parseVersion,
  compareVersions,
  isCompatible,
  isBreakingUpgrade,
  readCoreAutoVersion,
  checkVersionCompatibility,
  displayVersionWarning
};

