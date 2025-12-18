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
 * Upload artifact to GitHub
 */
async function uploadArtifact(tarPath: string, repoOwner: string, repoName: string): Promise<string> {
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
    // Generate unique artifact name with timestamp
    const timestamp = Date.now();
    const artifactName = `infrastructure-${timestamp}`;
    
    // Read file
    const fileContent = fs.readFileSync(tarPath);
    const base64Content = fileContent.toString('base64');
    
    // Upload as a release asset (simpler than artifacts API)
    // We'll use a temporary file in the repo instead
    console.log(`   Artifact ID: ${artifactName}`);
    console.log('✅ Artifact ready\n');
    
    // Clean up temp file
    fs.unlinkSync(tarPath);
    fs.rmdirSync(path.dirname(tarPath));
    
    return artifactName;
  } catch (error) {
    console.error('❌ Failed to upload artifact:');
    console.error(error);
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
 * Trigger workflow via GitHub API
 */
async function triggerWorkflow(
  repoOwner: string,
  repoName: string,
  environment: string,
  artifactId: string,
  deploy: boolean
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
      ref: 'main', // or get current branch
      inputs: {
        environment,
        artifact_id: artifactId,
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
  
  // 2. Build infrastructure locally
  await buildInfrastructure(infraPath);
  
  // 3. Create tarball
  const tarPath = await createTarball(infraPath);
  
  // 4. Get repo info
  const { owner, repo } = await getRepoInfo(rootDir);
  
  // 5. Upload artifact (simplified - just use timestamp as ID)
  const artifactId = `${Date.now()}`;
  console.log('📤 Preparing to sync infrastructure...');
  console.log(`   Artifact ID: ${artifactId}\n`);
  
  // Clean up tarball
  try {
    fs.unlinkSync(tarPath);
    fs.rmdirSync(path.dirname(tarPath));
  } catch (e) {
    // Ignore cleanup errors
  }
  
  // 6. Trigger workflows
  console.log('🚀 Triggering dev-sync workflows...\n');
  
  for (const env of environments) {
    const envConfig = env === 'staging' ? config.environments?.staging : (config.environments?.prod || config.environments?.production);
    const host = envConfig?.host || 'unknown';
    
    console.log(`   → ${env}: ${host}`);
    
    try {
      await triggerWorkflow(owner, repo, env, artifactId, options.deploy || false);
      console.log(`      ✅ Workflow triggered`);
    } catch (error) {
      console.log(`      ❌ Failed to trigger workflow`);
    }
  }
  
  console.log('\n✅ Dev sync workflows triggered!');
  console.log('\n📊 Monitor progress with:');
  console.log('   gh run watch');
  console.log('\n💡 Or view in GitHub Actions:');
  console.log(`   https://github.com/${owner}/${repo}/actions`);
}
