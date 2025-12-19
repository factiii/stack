/**
 * Dev Sync Command
 *
 * DEV/TESTING ONLY - Syncs locally built infrastructure to remote servers
 * for testing beta features of @factiii/stack itself before releasing.
 *
 * This is NOT for testing app code - only for developing the infrastructure package.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import { promisify } from 'util';
import yaml from 'js-yaml';
import { Octokit } from '@octokit/rest';

import type { FactiiiConfig, DevSyncOptions } from '../types/index.js';

const exec = promisify(child_process.exec);

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
 */
function getTargetEnvironments(config: FactiiiConfig, options: DevSyncOptions): string[] {
  const environments: string[] = [];
  
  if (options.staging) {
    if (config.environments?.staging) {
      environments.push('staging');
    } else {
      console.warn('⚠️  Staging environment not configured in factiii.yml');
    }
  }
  
  if (options.prod) {
    if (config.environments?.prod || config.environments?.production) {
      environments.push('prod');
    } else {
      console.warn('⚠️  Production environment not configured in factiii.yml');
    }
  }
  
  // If no specific environment specified, sync to all configured
  if (!options.staging && !options.prod) {
    if (config.environments?.staging) {
      environments.push('staging');
    }
    if (config.environments?.prod || config.environments?.production) {
      environments.push('prod');
    }
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
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'factiii-dev-sync-'));
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
 * Upload artifact to GitHub as a draft release
 */
async function uploadArtifact(tarPath: string, repoOwner: string, repoName: string): Promise<{ releaseId: number; assetId: number; tag: string }> {
  console.log('📤 Uploading infrastructure artifact to GitHub...');
  
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('❌ GITHUB_TOKEN environment variable not set');
    console.error('   Set it with: export GITHUB_TOKEN=your_token');
    console.error('   Or create one at: https://github.com/settings/tokens');
    process.exit(1);
  }
  
  const octokit = new Octokit({ auth: token });
  
  try {
    // Generate unique tag with timestamp
    const timestamp = Date.now();
    const tag = `dev-sync-${timestamp}`;
    
    console.log(`   Creating draft release: ${tag}`);
    
    // Create draft release
    const release = await octokit.repos.createRelease({
      owner: repoOwner,
      repo: repoName,
      tag_name: tag,
      name: `Dev Sync ${new Date().toISOString()}`,
      body: '⚠️ Temporary dev-sync artifact - will be deleted after sync',
      draft: true,
      prerelease: true
    });
    
    console.log(`   Uploading artifact (${(fs.statSync(tarPath).size / 1024 / 1024).toFixed(2)} MB)...`);
    
    // Read file and upload as release asset
    const fileContent = fs.readFileSync(tarPath);
    
    const asset = await octokit.repos.uploadReleaseAsset({
      owner: repoOwner,
      repo: repoName,
      release_id: release.data.id,
      name: 'infrastructure.tar.gz',
      data: fileContent as any,
    });
    
    console.log('✅ Artifact uploaded successfully\n');
    
    // Clean up local temp file
    fs.unlinkSync(tarPath);
    fs.rmdirSync(path.dirname(tarPath));
    
    return {
      releaseId: release.data.id,
      assetId: asset.data.id,
      tag
    };
  } catch (error) {
    console.error('❌ Failed to upload artifact:');
    if (error instanceof Error) {
      console.error(`   ${error.message}`);
    }
    process.exit(1);
  }
}

/**
 * Get repository info from git
 */
async function getRepoInfo(rootDir: string): Promise<{ owner: string; repo: string }> {
  try {
    const { stdout } = await exec('git remote get-url origin', { cwd: rootDir });
    const url = stdout.trim();
    
    // Parse GitHub URL (supports both HTTPS and SSH)
    const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (!match || !match[1] || !match[2]) {
      throw new Error('Could not parse GitHub repository URL');
    }
    
    return {
      owner: match[1],
      repo: match[2]
    };
  } catch (error) {
    console.error('❌ Failed to get repository info from git');
    console.error('   Make sure you are in a git repository with a GitHub remote');
    process.exit(1);
  }
}

/**
 * Get current git branch
 */
async function getCurrentBranch(rootDir: string): Promise<string> {
  try {
    const { stdout } = await exec('git rev-parse --abbrev-ref HEAD', { cwd: rootDir });
    return stdout.trim();
  } catch (error) {
    return 'main'; // fallback
  }
}

/**
 * Trigger workflow via GitHub API
 */
async function triggerWorkflow(
  repoOwner: string,
  repoName: string,
  environment: string,
  releaseId: number,
  assetId: number,
  deploy: boolean,
  branch: string
): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('❌ GITHUB_TOKEN not set');
    process.exit(1);
  }
  
  const octokit = new Octokit({ auth: token });
  
  try {
    await octokit.actions.createWorkflowDispatch({
      owner: repoOwner,
      repo: repoName,
      workflow_id: 'factiii-dev-sync.yml',
      ref: branch,
      inputs: {
        environment,
        release_id: releaseId.toString(),
        asset_id: assetId.toString(),
        deploy: deploy.toString()
      }
    });
  } catch (error) {
    console.error(`❌ Failed to trigger workflow for ${environment}:`);
    if (error instanceof Error) {
      console.error(`   ${error.message}`);
    }
    throw error;
  }
}

/**
 * Clean up draft release after successful sync
 */
async function cleanupRelease(repoOwner: string, repoName: string, releaseId: number): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return;
  
  const octokit = new Octokit({ auth: token });
  
  try {
    await octokit.repos.deleteRelease({
      owner: repoOwner,
      repo: repoName,
      release_id: releaseId
    });
  } catch (error) {
    // Ignore cleanup errors - not critical
    console.warn('   ⚠️  Failed to cleanup draft release (non-critical)');
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
  
  // 5. Get repo info and current branch
  const { owner, repo } = await getRepoInfo(rootDir);
  const branch = await getCurrentBranch(rootDir);
  
  // 6. Upload artifact to GitHub as draft release
  const { releaseId, assetId, tag } = await uploadArtifact(tarPath, owner, repo);
  
  console.log('📤 Preparing to sync infrastructure...');
  console.log(`   Release: ${tag}`);
  console.log(`   Branch: ${branch}\n`);
  
  // 7. Trigger workflows
  console.log('🚀 Triggering dev-sync workflows...\n');
  
  const successfulEnvs: string[] = [];
  
  for (const env of environments) {
    const envConfig = env === 'staging' ? config.environments?.staging : (config.environments?.prod || config.environments?.production);
    const host = envConfig?.host || 'unknown';
    
    console.log(`   → ${env}: ${host}`);
    
    try {
      await triggerWorkflow(owner, repo, env, releaseId, assetId, options.deploy || false, branch);
      console.log(`      ✅ Workflow triggered`);
      successfulEnvs.push(env);
    } catch (error) {
      console.log(`      ❌ Failed to trigger workflow`);
    }
  }
  
  console.log('\n✅ Dev sync workflows triggered!');
  console.log('\n📊 Monitor progress with:');
  console.log('   gh run watch');
  console.log('\n💡 Or view in GitHub Actions:');
  console.log(`   https://github.com/${owner}/${repo}/actions`);
  
  // 8. Wait a bit for workflows to start, then cleanup release
  if (successfulEnvs.length > 0) {
    console.log('\n🧹 Cleaning up draft release after workflows start...');
    // Give workflows 5 seconds to download the artifact
    await new Promise(resolve => setTimeout(resolve, 5000));
    await cleanupRelease(owner, repo, releaseId);
    console.log('   ✅ Draft release cleaned up');
  }
}

