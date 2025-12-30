/**
 * Dev Sync Command
 *
 * DEV/TESTING ONLY - Syncs locally built infrastructure to remote servers
 * for testing beta features of @factiii/stack itself before releasing.
 *
 * SETUP:
 * In repositories you are testing with, add this to package.json:
 *   "devDependencies": {
 *     "@factiii/stack": "link:../infrastructure"
 *   }
 *
 * Then use dev-sync to SSH and copy/paste the current infrastructure folder
 * to staging/prod servers. This simulates pulling from npm without having
 * the package published to npm.
 *
 * PRODUCTION:
 * When @factiii/stack is published to npm, this command will be disabled.
 * Production deployments will use npm to install @factiii/stack normally,
 * so no infrastructure folder will exist on servers - npm handles it.
 *
 * This is NOT for testing app code - only for developing the infrastructure package.
 * Uses direct SCP to transfer infrastructure to servers (no GitHub releases/workflows).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import * as child_process from 'child_process';
import { promisify } from 'util';

import yaml from 'js-yaml';
import type { FactiiiConfig, DevSyncOptions } from '../types/index.js';
import { extractEnvironments } from '../utils/config-helpers.js';

const exec = promisify(child_process.exec);

/**
 * Dev sync config structure
 */
interface DevSyncConfig {
  sshKeys: {
    stagingPath?: string;
    prodPath?: string;
  };
}

/**
 * Get path to dev-sync config file
 */
function getDevSyncConfigPath(): string {
  const homeDir = os.homedir();
  const factiiiDir = path.join(homeDir, '.factiii');
  return path.join(factiiiDir, 'dev-sync.json');
}

/**
 * Load dev-sync config from ~/.factiii/dev-sync.json
 */
function loadDevSyncConfig(): DevSyncConfig {
  const configPath = getDevSyncConfigPath();
  
  if (!fs.existsSync(configPath)) {
    return { sshKeys: {} };
  }
  
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(content) as DevSyncConfig;
    return config || { sshKeys: {} };
  } catch (error) {
    // If config file is corrupted, return empty config
    console.warn(`⚠️  Could not read dev-sync config: ${error instanceof Error ? error.message : String(error)}`);
    return { sshKeys: {} };
  }
}

/**
 * Save dev-sync config to ~/.factiii/dev-sync.json
 */
function saveDevSyncConfig(config: DevSyncConfig): void {
  const configPath = getDevSyncConfigPath();
  const factiiiDir = path.dirname(configPath);
  
  // Create ~/.factiii directory if it doesn't exist
  if (!fs.existsSync(factiiiDir)) {
    fs.mkdirSync(factiiiDir, { mode: 0o700 });
  }
  
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  } catch (error) {
    console.warn(`⚠️  Could not save dev-sync config: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Load config from factiii.yml
 */
function loadConfig(rootDir: string): FactiiiConfig {
  const configPath = path.join(rootDir, 'factiii.yml');

  if (!fs.existsSync(configPath)) {
    console.error('❌ factiii.yml not found in current directory');
    console.error('   Make sure you are running this from your app repository');
    process.exit(1);
  }

  try {
    return (yaml.load(fs.readFileSync(configPath, 'utf8')) as FactiiiConfig) ?? ({} as FactiiiConfig);
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.error(`❌ Error parsing factiii.yml: ${errorMessage}`);
    process.exit(1);
  }
}

/**
 * Find infrastructure path by looking for link: in package.json
 */
function findInfrastructurePath(rootDir: string): string {
  const packageJsonPath = path.join(rootDir, 'package.json');
  
  if (!fs.existsSync(packageJsonPath)) {
    console.error('❌ package.json not found');
    process.exit(1);
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  
  // Check devDependencies for link: dependency
  const devDeps = packageJson.devDependencies || {};
  const factiiiStack = devDeps['@factiii/stack'];
  
  if (!factiiiStack || !factiiiStack.startsWith('link:')) {
    console.error('❌ No link: dependency found for @factiii/stack in package.json');
    console.error('   Expected: "@factiii/stack": "link:/path/to/infrastructure"');
    console.error('   This command requires a local link to the infrastructure package');
    process.exit(1);
  }

  // Extract path from link:
  const infraPath = factiiiStack.replace('link:', '');
  const resolvedPath = path.resolve(rootDir, infraPath);
  
  if (!fs.existsSync(resolvedPath)) {
    console.error(`❌ Infrastructure path not found: ${resolvedPath}`);
    process.exit(1);
  }

  return resolvedPath;
}

/**
 * Get target environments based on config and options
 * Supports both v1.x and v2.0.0 config formats
 */
function getTargetEnvironments(config: FactiiiConfig, options: DevSyncOptions): string[] {
  const environments: string[] = [];
  const allEnvs = extractEnvironments(config);
  const envNames = Object.keys(allEnvs);

  if (options.staging) {
    // Look for any staging-type environment
    const stagingEnv = envNames.find(name => name.startsWith('staging') || name.startsWith('stage-'));
    if (stagingEnv) {
      environments.push(stagingEnv);
    } else {
      console.warn('⚠️  Staging environment not configured in factiii.yml');
    }
  }

  if (options.prod) {
    // Look for any prod-type environment
    const prodEnv = envNames.find(name => name.startsWith('prod') || name === 'production');
    if (prodEnv) {
      environments.push(prodEnv);
    } else {
      console.warn('⚠️  Production environment not configured in factiii.yml');
    }
  }

  // If no specific environment specified, sync to all configured
  if (!options.staging && !options.prod) {
    // Add all configured environments
    environments.push(...envNames);
  }

  if (environments.length === 0) {
    console.error('❌ No environments configured in factiii.yml');
    console.error('   Add staging and/or prod environments to factiii.yml');
    process.exit(1);
  }

  return environments;
}

/**
 * Auto-increment dev version in package.json
 * Converts 2.0.1 -> 2.0.1-d1, or 2.0.1-d1 -> 2.0.1-d2
 */
function incrementDevVersion(infraPath: string): string {
  const packageJsonPath = path.join(infraPath, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  let version = pkg.version;

  // If has -d suffix, increment; otherwise add -d1
  if (version.includes('-d')) {
    const match = version.match(/-d(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10) + 1;
      version = version.replace(/-d\d+$/, `-d${num}`);
    }
  } else {
    version = `${version}-d1`;
  }

  // Update package.json
  pkg.version = version;
  fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n');

  return version;
}

/**
 * Build infrastructure locally
 */
async function buildInfrastructure(infraPath: string): Promise<void> {
  console.log('📦 Building infrastructure locally...');
  
  try {
    const { stdout, stderr } = await exec('npm run build', { 
      cwd: infraPath,
      env: { ...process.env, NODE_ENV: 'production' }
    });
    
    if (stderr && !stderr.includes('npm WARN')) {
      console.log(stderr);
    }
    
    console.log('✅ Built successfully\n');
  } catch (error) {
    console.error('❌ Build failed:');
    if (error instanceof Error && 'stdout' in error) {
      console.error((error as any).stdout);
      console.error((error as any).stderr);
    }
    process.exit(1);
  }
}

/**
 * Create tarball of infrastructure
 */
async function createTarball(infraPath: string): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factiii-dev-sync-'));
  const tarPath = path.join(tmpDir, 'infrastructure.tar.gz');
  
  console.log('📦 Creating artifact...');
  
  try {
    // Create tar excluding node_modules and .git
    await exec(
      `tar -czf "${tarPath}" --exclude='node_modules' --exclude='.git' --exclude='*.log' -C "${infraPath}" .`,
      { maxBuffer: 50 * 1024 * 1024 } // 50MB buffer
    );
    
    const stats = fs.statSync(tarPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`✅ Artifact created (${sizeMB} MB)\n`);
    
    return tarPath;
  } catch (error) {
    console.error('❌ Failed to create tarball:');
    console.error(error);
    process.exit(1);
  }
}

/**
 * Get SSH key from environment, saved config, or prompt user
 */
async function getOrPromptSSHKey(environment: string): Promise<string> {
  // Check environment variable first
  const envVar = environment === 'staging' ? 'STAGING_SSH' : 'PROD_SSH';
  const sshKeyFromEnv = process.env[envVar];
  
  if (sshKeyFromEnv) {
    // Check if it's a file path
    if (fs.existsSync(sshKeyFromEnv)) {
      // It's a file path - use it directly
      return path.resolve(sshKeyFromEnv);
    } else {
      // It's the key content - save to temp file
      const tmpDir = os.tmpdir();
      const keyPath = path.join(tmpDir, `factiii-ssh-${environment}-${Date.now()}`);
      fs.writeFileSync(keyPath, sshKeyFromEnv);
      fs.chmodSync(keyPath, 0o600);
      return keyPath;
    }
  }
  
  // Check saved config file
  const config = loadDevSyncConfig();
  const configKey = environment === 'staging' ? 'stagingPath' : 'prodPath';
  const savedPath = config.sshKeys[configKey];
  
  if (savedPath && fs.existsSync(savedPath)) {
    const resolvedPath = path.resolve(savedPath);
    console.log(`✅ Using saved SSH key path: ${resolvedPath}\n`);
    return resolvedPath;
  }
  
  // If saved path doesn't exist, remove it from config
  if (savedPath && !fs.existsSync(savedPath)) {
    const updatedConfig = { ...config };
    delete updatedConfig.sshKeys[configKey];
    saveDevSyncConfig(updatedConfig);
  }
  
  // Prompt user for SSH key
  console.log(`\n🔑 SSH key not found in ${envVar} environment variable`);
  console.log('   Please provide your SSH private key for this environment');
  console.log('   You can paste the key content or provide a file path');
  console.log('   Note: File paths will be remembered for next time (key content will not be saved)\n');
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve, reject) => {
    rl.question('SSH key (paste content or file path): ', async (answer) => {
      rl.close();
      
      let keyPath: string;
      const trimmed = answer.trim();
      let isFilePath = false;
      
      // Check if it's a file path
      if (fs.existsSync(trimmed)) {
        keyPath = path.resolve(trimmed);
        isFilePath = true;
      } else {
        // It's the key content - save to temp file
        const tmpDir = os.tmpdir();
        keyPath = path.join(tmpDir, `factiii-ssh-${environment}-${Date.now()}`);
        fs.writeFileSync(keyPath, trimmed);
        fs.chmodSync(keyPath, 0o600);
        isFilePath = false;
      }
      
      // Verify it's a valid key file
      if (!fs.existsSync(keyPath)) {
        console.error('❌ SSH key file not found');
        process.exit(1);
      }
      
      // Save file path to config for next time (only if it's a file path, not key content)
      if (isFilePath) {
        const updatedConfig = loadDevSyncConfig();
        updatedConfig.sshKeys[configKey] = keyPath;
        saveDevSyncConfig(updatedConfig);
        console.log('✅ SSH key path saved for next time\n');
      } else {
        console.log('✅ Using SSH key (not saved - use file path to remember)\n');
      }
      
      resolve(keyPath);
    });
  });
}

/**
 * SCP tarball to server and extract
 */
async function syncToServer(
  tarPath: string,
  environment: string,
  config: FactiiiConfig,
  sshKeyPath: string
): Promise<void> {
  // Get environment config (supports both v1.x and v2.0.0 formats)
  const allEnvs = extractEnvironments(config);
  const envConfig = allEnvs[environment];

  if (!envConfig?.host) {
    console.error(`❌ ${environment} host not configured in factiii.yml`);
    process.exit(1);
  }

  const host = envConfig.host;
  const user = envConfig.ssh_user || 'ubuntu';
  
  console.log(`📤 Syncing to ${environment} (${user}@${host})...`);
  
  try {
    // SCP tarball to server
    console.log('   Uploading tarball...');
    await exec(
      `scp -i "${sshKeyPath}" -o StrictHostKeyChecking=no "${tarPath}" "${user}@${host}:/tmp/infrastructure.tar.gz"`,
      { maxBuffer: 50 * 1024 * 1024 }
    );
    
    // SSH to server and extract
    console.log('   Extracting on server...');
    await exec(
      `ssh -i "${sshKeyPath}" -o StrictHostKeyChecking=no "${user}@${host}" \
        "mkdir -p ~/.factiii/infrastructure && \
         cd ~/.factiii/infrastructure && \
         tar -xzf /tmp/infrastructure.tar.gz && \
         rm /tmp/infrastructure.tar.gz && \
         echo '📦 Installing infrastructure dependencies...' && \
         export PATH=\"/opt/homebrew/bin:/usr/local/bin:\$PATH\" && \
         if [ -f 'pnpm-lock.yaml' ]; then \
           command -v pnpm >/dev/null 2>&1 || npm install -g pnpm && \
           pnpm install; \
         else \
           npm install; \
         fi && \
         echo '✅ Infrastructure synced successfully'"`
    );
    
    console.log(`   ✅ Synced to ${environment}\n`);
  } catch (error) {
    console.error(`❌ Failed to sync to ${environment}:`);
    if (error instanceof Error) {
      console.error(`   ${error.message}`);
    }
    throw error;
  }
}

/**
 * Deploy after sync (optional)
 */
async function deployAfterSync(
  environment: string,
  config: FactiiiConfig,
  sshKeyPath: string
): Promise<void> {
  // Get environment config (supports both v1.x and v2.0.0 formats)
  const allEnvs = extractEnvironments(config);
  const envConfig = allEnvs[environment];

  if (!envConfig?.host) {
    return;
  }

  const host = envConfig.host;
  const user = envConfig.ssh_user || 'ubuntu';
  const repoName = config.name || 'app';
  
  console.log(`🚀 Deploying to ${environment}...`);
  
  try {
    await exec(
      `ssh -i "${sshKeyPath}" -o StrictHostKeyChecking=no "${user}@${host}" \
        "export PATH=\"/opt/homebrew/bin:/usr/local/bin:\$PATH\" && \
         cd ~/.factiii/${repoName} && \
         GITHUB_ACTIONS=true node ~/.factiii/infrastructure/bin/factiii deploy --${environment}"`
    );
    
    console.log(`   ✅ Deployed to ${environment}\n`);
  } catch (error) {
    console.error(`❌ Deployment failed for ${environment}:`);
    if (error instanceof Error) {
      console.error(`   ${error.message}`);
    }
    throw error;
  }
}

/**
 * Dev sync command - sync locally built infrastructure to servers
 */
export async function devSync(options: DevSyncOptions = {}): Promise<void> {
  const rootDir = options.rootDir ?? process.cwd();
  
  console.log('════════════════════════════════════════════════════════════');
  console.log('🔧 DEV SYNC - Testing uncommitted infrastructure changes');
  console.log('════════════════════════════════════════════════════════════');
  console.log('⚠️  This is a development command - not for production releases');
  console.log('⚠️  Only for testing @factiii/stack beta features\n');
  
  // 1. Load config and validate
  const config = loadConfig(rootDir);
  const infraPath = findInfrastructurePath(rootDir);
  const environments = getTargetEnvironments(config, options);
  
  console.log(`📍 Infrastructure path: ${infraPath}`);
  console.log(`🎯 Target environments: ${environments.join(', ')}\n`);
  
  // 2. Increment dev version
  const devVersion = incrementDevVersion(infraPath);
  console.log(`📦 Dev version: ${devVersion}\n`);
  
  // 3. Build infrastructure locally
  await buildInfrastructure(infraPath);
  
  // 4. Create tarball
  const tarPath = await createTarball(infraPath);
  
  // 5. Sync to each environment
  const sshKeyPaths: Map<string, string> = new Map();
  const cleanupPaths: string[] = [];
  
  try {
    for (const env of environments) {
      // Get SSH key for this environment
      let sshKeyPath = sshKeyPaths.get(env);
      if (!sshKeyPath) {
        sshKeyPath = await getOrPromptSSHKey(env);
        sshKeyPaths.set(env, sshKeyPath);
        
        // Track temp files for cleanup (only if we created them)
        if (sshKeyPath.includes(os.tmpdir())) {
          cleanupPaths.push(sshKeyPath);
        }
      }
      
      // Sync to server
      await syncToServer(tarPath, env, config, sshKeyPath);
      
      // Optionally deploy
      if (options.deploy) {
        await deployAfterSync(env, config, sshKeyPath);
      }
    }
    
    console.log('✅ Dev sync complete!');
  } catch (error) {
    console.error('\n❌ Dev sync failed');
    throw error;
  } finally {
    // Cleanup temp files
    try {
      // Remove tarball
      if (fs.existsSync(tarPath)) {
        fs.unlinkSync(tarPath);
        fs.rmdirSync(path.dirname(tarPath));
      }
      
      // Remove SSH key temp files
      for (const keyPath of cleanupPaths) {
        if (fs.existsSync(keyPath)) {
          fs.unlinkSync(keyPath);
        }
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  }
}
