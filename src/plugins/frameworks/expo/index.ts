/**
 * Expo (React Native) Framework Plugin
 *
 * Validates all dependencies needed for EAS Build to work.
 * Each dependency has its own scanfix so `eas build` succeeds
 * once all checks pass.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

import type { FactiiiConfig, Fix, DeployResult } from '../../../types/index.js';
import { loadLocalConfig } from '../../../utils/config-helpers.js';

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface AppJson {
  expo?: {
    name?: string;
    slug?: string;
    ios?: { bundleIdentifier?: string };
    android?: { package?: string };
    extra?: { eas?: { projectId?: string } };
  };
}

interface DetectedConfig {
  has_expo: boolean;
  expo_version?: string | null;
  has_app_json: boolean;
  has_eas_json: boolean;
}

/**
 * Read and parse app.json from rootDir
 */
function readAppJson(rootDir: string): AppJson | null {
  const appJsonPath = path.join(rootDir, 'app.json');
  if (!fs.existsSync(appJsonPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(appJsonPath, 'utf8')) as AppJson;
  } catch {
    return null;
  }
}

/**
 * Check if any app config file exists (app.json, app.config.js, app.config.ts)
 */
function hasAppConfig(rootDir: string): boolean {
  return (
    fs.existsSync(path.join(rootDir, 'app.json')) ||
    fs.existsSync(path.join(rootDir, 'app.config.js')) ||
    fs.existsSync(path.join(rootDir, 'app.config.ts'))
  );
}

/**
 * Get dev OS from stack.local.yml or fall back to process.platform
 */
function getDevOS(rootDir: string): 'mac' | 'windows' | 'ubuntu' {
  const localConfig = loadLocalConfig(rootDir);
  if (localConfig.dev_os) return localConfig.dev_os as 'mac' | 'windows' | 'ubuntu';
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'windows';
  return 'ubuntu';
}

class ExpoPlugin {
  // ============================================================
  // STATIC METADATA
  // ============================================================

  static readonly id = 'expo';
  static readonly name = 'Expo (React Native)';
  static readonly category: 'framework' = 'framework';
  static readonly version = '1.0.0';

  static readonly requiredEnvVars: string[] = [];

  static readonly configSchema: Record<string, unknown> = {
    expo: {
      profile: null, // Optional: EAS build profile override
    },
  };

  static readonly autoConfigSchema: Record<string, string> = {
    has_expo: 'boolean',
    expo_version: 'string',
    has_app_json: 'boolean',
    has_eas_json: 'boolean',
  };

  /**
   * Determine if this plugin should be loaded for this project
   * Loads if 'expo' is in package.json dependencies
   */
  static async shouldLoad(rootDir: string, _config: FactiiiConfig): Promise<boolean> {
    const pkgPath = path.join(rootDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PackageJson;
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      return !!deps.expo;
    } catch {
      return false;
    }
  }

  // ============================================================
  // FIXES - All EAS Build dependencies
  // ============================================================

  static readonly fixes: Fix[] = [
    // ============================================================
    // CLI & Runtime
    // ============================================================
    {
      id: 'expo-not-installed',
      stage: 'dev',
      severity: 'critical',
      description: 'Expo SDK not found in package.json dependencies',
      scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        const pkgPath = path.join(rootDir, 'package.json');
        if (!fs.existsSync(pkgPath)) return true;

        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PackageJson;
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          return !deps.expo;
        } catch {
          return true;
        }
      },
      fix: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        try {
          execSync('pnpm add expo', { cwd: rootDir, stdio: 'inherit' });
          console.log('   Installed Expo SDK');
          return true;
        } catch {
          return false;
        }
      },
      manualFix: 'Run: pnpm add expo',
    },
    {
      id: 'eas-cli-not-installed',
      stage: 'dev',
      severity: 'critical',
      description: 'EAS CLI not installed (required for eas build)',
      scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        try {
          execSync('npx eas --version', { stdio: 'pipe' });
          return false;
        } catch {
          return true;
        }
      },
      fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        try {
          execSync('pnpm add -g eas-cli', { stdio: 'inherit' });
          console.log('   Installed eas-cli globally');
          return true;
        } catch {
          return false;
        }
      },
      manualFix: 'Run: pnpm add -g eas-cli',
    },

    // ============================================================
    // Config Files
    // ============================================================
    {
      id: 'expo-app-config-missing',
      stage: 'dev',
      severity: 'critical',
      description: 'Expo app config not found (app.json, app.config.js, or app.config.ts)',
      scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        return !hasAppConfig(rootDir);
      },
      fix: null,
      manualFix:
        'Create app.json in your project root:\n' +
        '      {\n' +
        '        "expo": {\n' +
        '          "name": "My App",\n' +
        '          "slug": "my-app",\n' +
        '          "version": "1.0.0",\n' +
        '          "ios": { "bundleIdentifier": "com.example.myapp" },\n' +
        '          "android": { "package": "com.example.myapp" }\n' +
        '        }\n' +
        '      }',
    },
    {
      id: 'expo-eas-json-missing',
      stage: 'dev',
      severity: 'critical',
      description: 'eas.json not found (required for EAS Build configuration)',
      scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        return !fs.existsSync(path.join(rootDir, 'eas.json'));
      },
      fix: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        try {
          execSync('npx eas build:configure', { cwd: rootDir, stdio: 'inherit' });
          console.log('   Created eas.json via eas build:configure');
          return true;
        } catch {
          return false;
        }
      },
      manualFix: 'Run: npx eas build:configure',
    },
    {
      id: 'expo-app-name-missing',
      stage: 'dev',
      severity: 'warning',
      description: 'Expo app name or slug missing in app.json',
      scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        const appJson = readAppJson(rootDir);
        if (!appJson) return false; // Caught by expo-app-config-missing

        return !appJson.expo?.name || !appJson.expo?.slug;
      },
      fix: null,
      manualFix:
        'Add name and slug to app.json:\n' +
        '      "expo": {\n' +
        '        "name": "Your App Name",\n' +
        '        "slug": "your-app-slug"\n' +
        '      }',
    },
    {
      id: 'expo-bundle-id-missing',
      stage: 'dev',
      severity: 'warning',
      description: 'iOS bundleIdentifier not set in app.json (required for iOS builds)',
      scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        const appJson = readAppJson(rootDir);
        if (!appJson) return false; // Caught by expo-app-config-missing

        return !appJson.expo?.ios?.bundleIdentifier;
      },
      fix: null,
      manualFix:
        'Add ios.bundleIdentifier to app.json:\n' +
        '      "expo": {\n' +
        '        "ios": { "bundleIdentifier": "com.yourcompany.yourapp" }\n' +
        '      }',
    },
    {
      id: 'expo-package-name-missing',
      stage: 'dev',
      severity: 'warning',
      description: 'Android package name not set in app.json (required for Android builds)',
      scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        const appJson = readAppJson(rootDir);
        if (!appJson) return false; // Caught by expo-app-config-missing

        return !appJson.expo?.android?.package;
      },
      fix: null,
      manualFix:
        'Add android.package to app.json:\n' +
        '      "expo": {\n' +
        '        "android": { "package": "com.yourcompany.yourapp" }\n' +
        '      }',
    },

    // ============================================================
    // Auth
    // ============================================================
    {
      id: 'expo-not-logged-in',
      stage: 'dev',
      severity: 'critical',
      description: 'Not logged into Expo account (required for EAS Build)',
      scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        try {
          execSync('npx eas whoami', { stdio: 'pipe' });
          return false;
        } catch {
          return true;
        }
      },
      fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        try {
          execSync('npx eas login', { stdio: 'inherit' });
          // Verify login succeeded
          execSync('npx eas whoami', { stdio: 'pipe' });
          console.log('   Logged into Expo account');
          return true;
        } catch {
          return false;
        }
      },
      manualFix:
        'Log into your Expo account:\n' +
        '      npx eas login\n' +
        '      For CI, set EXPO_TOKEN environment variable',
    },

    // ============================================================
    // Platform Tools (OS-aware)
    // ============================================================
    {
      id: 'expo-xcode-missing',
      stage: 'dev',
      severity: 'warning',
      description: 'Xcode not installed (required for local iOS builds)',
      scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        const devOS = getDevOS(rootDir);
        if (devOS !== 'mac') return false; // Only check on macOS

        try {
          execSync('xcodebuild -version', { stdio: 'pipe' });
          return false;
        } catch {
          return true;
        }
      },
      fix: null,
      manualFix:
        'Install Xcode from the Mac App Store:\n' +
        '      1. Open App Store and search for "Xcode"\n' +
        '      2. Install Xcode\n' +
        '      3. Run: sudo xcode-select --switch /Applications/Xcode.app\n' +
        '      4. Run: sudo xcodebuild -license accept',
    },
    {
      id: 'expo-cocoapods-missing',
      stage: 'dev',
      severity: 'warning',
      description: 'CocoaPods not installed (required for iOS builds)',
      scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        const devOS = getDevOS(rootDir);
        if (devOS !== 'mac') return false; // Only check on macOS

        try {
          execSync('pod --version', { stdio: 'pipe' });
          return false;
        } catch {
          return true;
        }
      },
      fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        try {
          execSync('brew install cocoapods', { stdio: 'inherit' });
          console.log('   Installed CocoaPods via Homebrew');
          return true;
        } catch {
          // Fallback to gem install
          try {
            execSync('sudo gem install cocoapods', { stdio: 'inherit' });
            console.log('   Installed CocoaPods via gem');
            return true;
          } catch {
            return false;
          }
        }
      },
      manualFix: 'Run: brew install cocoapods  (or: sudo gem install cocoapods)',
    },
    {
      id: 'expo-jdk-missing',
      stage: 'dev',
      severity: 'warning',
      description: 'JDK 17+ not installed (required for Android builds)',
      scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        try {
          const output = execSync('java -version 2>&1', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          // Parse version: "openjdk version "17.0.x"" or "java version "17.0.x""
          const versionMatch = output.match(/version "(\d+)/);
          if (versionMatch) {
            const major = parseInt(versionMatch[1]!, 10);
            return major < 17;
          }
          return true; // Can't parse version
        } catch {
          return true;
        }
      },
      fix: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        const devOS = getDevOS(rootDir);
        try {
          if (devOS === 'mac') {
            execSync('brew install openjdk@17', { stdio: 'inherit' });
            console.log('   Installed JDK 17 via Homebrew');
          } else if (devOS === 'windows') {
            execSync('winget install --id=EclipseAdoptium.Temurin.17.JDK --accept-source-agreements --accept-package-agreements', { stdio: 'inherit' });
            console.log('   Installed JDK 17 via winget');
          } else {
            execSync('sudo apt-get install -y openjdk-17-jdk', { stdio: 'inherit' });
            console.log('   Installed JDK 17 via apt-get');
          }
          return true;
        } catch {
          return false;
        }
      },
      manualFix:
        'Install JDK 17+:\n' +
        '      macOS:   brew install openjdk@17\n' +
        '      Windows: winget install EclipseAdoptium.Temurin.17.JDK\n' +
        '      Linux:   sudo apt-get install openjdk-17-jdk',
    },
    {
      id: 'expo-android-sdk-missing',
      stage: 'dev',
      severity: 'info',
      description: 'ANDROID_HOME not set (Android SDK required for local Android builds)',
      scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
        if (!androidHome) return true;
        return !fs.existsSync(androidHome);
      },
      fix: null,
      manualFix:
        'Install Android Studio and set ANDROID_HOME:\n' +
        '      1. Download Android Studio from https://developer.android.com/studio\n' +
        '      2. Install and open Android Studio\n' +
        '      3. Install Android SDK via SDK Manager\n' +
        '      4. Set ANDROID_HOME environment variable:\n' +
        '         macOS:   export ANDROID_HOME=$HOME/Library/Android/sdk\n' +
        '         Windows: setx ANDROID_HOME "%LOCALAPPDATA%\\Android\\Sdk"\n' +
        '         Linux:   export ANDROID_HOME=$HOME/Android/Sdk',
    },

    // ============================================================
    // Project Integrity
    // ============================================================
    {
      id: 'expo-project-id-missing',
      stage: 'dev',
      severity: 'warning',
      description: 'EAS project ID not configured (required for EAS Build)',
      scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        const appJson = readAppJson(rootDir);
        if (!appJson) return false; // Caught by expo-app-config-missing

        // Check app.json for projectId
        if (appJson.expo?.extra?.eas?.projectId) return false;

        // Also check app.config.js/ts (can't parse, but check if eas.json has projectId)
        const easJsonPath = path.join(rootDir, 'eas.json');
        if (fs.existsSync(easJsonPath)) {
          try {
            const easJson = JSON.parse(fs.readFileSync(easJsonPath, 'utf8'));
            // eas.json doesn't store projectId, but if eas init was run, app.json would have it
          } catch {
            // ignore
          }
        }

        return true;
      },
      fix: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        try {
          execSync('npx eas init', { cwd: rootDir, stdio: 'inherit' });
          console.log('   Configured EAS project ID');
          return true;
        } catch {
          return false;
        }
      },
      manualFix: 'Run: npx eas init (links your project to an EAS project)',
    },
  ];

  // ============================================================
  // STATIC HELPER METHODS
  // ============================================================

  /**
   * Auto-detect Expo configuration
   */
  static async detectConfig(rootDir: string): Promise<DetectedConfig | null> {
    const pkgPath = path.join(rootDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return null;

    let expoVersion: string | null = null;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PackageJson;
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (!deps.expo) return null;
      expoVersion = deps.expo ? deps.expo.replace(/^[\^~]/, '') : null;
    } catch {
      return null;
    }

    return {
      has_expo: true,
      expo_version: expoVersion,
      has_app_json: fs.existsSync(path.join(rootDir, 'app.json')),
      has_eas_json: fs.existsSync(path.join(rootDir, 'eas.json')),
    };
  }

  // ============================================================
  // INSTANCE METHODS
  // ============================================================

  private _config: FactiiiConfig;

  constructor(config: FactiiiConfig) {
    this._config = config;
  }

  /**
   * Deploy - trigger EAS Build
   */
  async deploy(_config: FactiiiConfig, environment: string): Promise<DeployResult> {
    const rootDir = process.cwd();
    const profile = environment === 'prod' ? 'production' : environment;

    console.log('   Building with EAS for ' + environment + ' (profile: ' + profile + ')...');

    try {
      execSync('npx eas build --profile ' + profile + ' --non-interactive', {
        cwd: rootDir,
        stdio: 'inherit',
      });
      return { success: true, message: 'EAS Build submitted for ' + environment };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Undeploy - nothing to do for Expo
   */
  async undeploy(_config: FactiiiConfig, _environment: string): Promise<DeployResult> {
    return { success: true, message: 'Nothing to undeploy for Expo' };
  }
}

export default ExpoPlugin;
