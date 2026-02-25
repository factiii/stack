/**
 * Generate stack.yml
 *
 * Generates the stack.yml configuration file from plugin schemas.
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { execSync } from 'child_process';

import { STACK_CONFIG_FILENAME } from '../constants/config-files.js';
import type { FactiiiConfig } from '../types/index.js';

interface PluginWithSchema {
  configSchema?: Record<string, unknown>;
}

interface GenerateOptions {
  force?: boolean;
  plugins?: PluginWithSchema[];
}

/**
 * Load all plugins
 */
function loadAllPlugins(): PluginWithSchema[] {
  const plugins: PluginWithSchema[] = [];

  // Load pipeline plugins
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const FactiiiPipeline = require('../plugins/pipelines/factiii') as PluginWithSchema;
    plugins.push(FactiiiPipeline);
  } catch {
    // Plugin not available
  }

  // Load server plugins
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const MacPlugin = require('../plugins/servers/mac') as PluginWithSchema;
    plugins.push(MacPlugin);
  } catch {
    // Plugin not available
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const UbuntuPlugin = require('../plugins/servers/ubuntu') as PluginWithSchema;
    plugins.push(UbuntuPlugin);
  } catch {
    // Plugin not available
  }

  // Load pipeline plugins (AWS is now a pipeline, not a server)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AWSPipeline = require('../plugins/pipelines/aws') as PluginWithSchema;
    plugins.push(AWSPipeline);
  } catch {
    // Plugin not available
  }

  // Load framework plugins
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const PrismaTrpcPlugin = require('../plugins/frameworks/prisma-trpc') as PluginWithSchema;
    plugins.push(PrismaTrpcPlugin);
  } catch {
    // Plugin not available
  }

  return plugins;
}

/**
 * Generate stack.yml template from plugin schemas
 * @param plugins - Optional array of plugin classes to use
 */
export function generateFactiiiYmlTemplate(plugins: PluginWithSchema[] | null = null): string {
  const actualPlugins = plugins ?? loadAllPlugins();

  // Base schema with core fields
  const schema: Record<string, unknown> = {
    // ============================================================
    // RESERVED CONFIG FIELDS
    // ============================================================
    name: 'EXAMPLE_your-repo-name',
    config_version: '0.1.0',
    github_repo: 'EXAMPLE_username/repo-name',
    ssl_email: 'EXAMPLE_admin@yourdomain.com',
    pipeline: 'factiii',  // Pipeline plugin (e.g., factiii for GitHub Actions)

    // Ansible Vault configuration (for secrets)
    ansible: {
      vault_path: 'group_vars/all/vault.yml',  // Path to Ansible Vault file
      vault_password_file: '~/.vault_pass',    // Optional: path to vault password file
    },

    // ============================================================
    // ENVIRONMENTS (top-level keys)
    // ============================================================
    staging: {
      server: 'mac',  // Server OS type (mac, ubuntu, windows, amazon-linux)
      domain: 'EXAMPLE_staging.yourdomain.com',  // Used for nginx AND SSH
      env_file: '.env.staging',
    },

    prod: {
      server: 'ubuntu',  // Server OS type
      pipeline: 'aws',   // Use AWS pipeline for deployment
      domain: 'EXAMPLE_yourdomain.com',  // Used for nginx AND SSH

      // AWS-specific config (when server: aws)
      config: 'free-tier', // Options: ec2, free-tier, standard, enterprise
      access_key_id: 'EXAMPLE_AKIAXXXXXXXX',
      region: 'us-east-1',

      // Plugin configs for this environment
      plugins: {
        ecr: {
          ecr_registry: 'EXAMPLE_123456789012.dkr.ecr.us-east-1.amazonaws.com',
          ecr_repository: 'EXAMPLE_repo-name',
        },
      },
    },
  };

  // Merge plugin config schemas
  for (const PluginClass of actualPlugins) {
    if (PluginClass.configSchema) {
      Object.assign(schema, PluginClass.configSchema);
    }
  }

  const yamlContent = yaml.dump(schema, {
    lineWidth: -1, // Don't wrap lines
    noRefs: true,
  });

  // Add helpful comments after YAML generation
  const comments = `
# ============================================================
# ADDITIONAL ENVIRONMENTS
# ============================================================
# You can add as many environments as needed (staging2, prod2, qa, demo, etc.)
# Each environment must specify a 'server' plugin and can have server-specific configs.
#
# Example - Additional staging environment:
# staging2:
#   server: mac
#   domain: staging2.yourdomain.com
#   env_file: .env.staging2
#
# Example - Additional prod environment:
# prod2:
#   server: ubuntu
#   pipeline: aws
#   domain: app2.yourdomain.com
#   config: free-tier
#   access_key_id: EXAMPLE_AKIAXXXXXXXX
#   region: us-west-2

# ============================================================
# ENVIRONMENT OPTIONS
# ============================================================
# All environments support these optional fields:
#   ssh_user: ubuntu  # Override SSH user (defaults to stackAuto.yml ssh_user)
#   env_file: .env.{environment}  # Override env file name

# ============================================================
# CONTAINER EXCLUSIONS
# ============================================================
# Exclude Docker containers from unmanaged container cleanup
# Uncomment and add container names to keep them running:
# container_exclusions:
#   - factiii_postgres
#   - legacy_container
`;

  return yamlContent + comments;
}

/**
 * Generate stack.yml file in the target directory
 */
export function generateFactiiiYml(rootDir: string, options: GenerateOptions = {}): boolean {
  const outputPath = path.join(rootDir, STACK_CONFIG_FILENAME);

  // Check if file already exists
  if (fs.existsSync(outputPath) && !options.force) {
    console.log('⏭️  ' + STACK_CONFIG_FILENAME + ' already exists (use --force to overwrite)');
    return false;
  }

  // Use provided plugins or load all
  const content = generateFactiiiYmlTemplate(options.plugins ?? null);

  // Write file
  fs.writeFileSync(outputPath, content);

  console.log('[OK] Created ' + STACK_CONFIG_FILENAME);
  console.log('');
  console.log('     This is the configuration file for everything.');
  console.log('');
  console.log('NEXT STEPS:');
  console.log('');
  console.log('  1. Update this file:');
  console.log('     [ ] Replace all EXAMPLE_ values in ' + STACK_CONFIG_FILENAME);
  console.log('         (ssl_email, staging.domain, prod.domain)');
  console.log('');
  console.log('  2. Set up secrets:');
  console.log('     [ ] npx stack init        (vault + SSH keys + credentials)');
  console.log('');
  console.log('  3. Scan for issues:');
  console.log('     [ ] npx stack scan        (read-only check - changes nothing)');
  console.log('');
  console.log('  4. Auto-fix issues:');
  console.log('     [ ] npx stack fix         (installs tools, creates configs)');
  console.log('');
  console.log('  5. Deploy:');
  console.log('     [ ] npx stack deploy --staging --dry-run   (preview)');
  console.log('     [ ] npx stack deploy --staging             (deploy)');
  console.log('');

  return true;
}

/**
 * Read package.json from a directory
 */
function readPackageJson(rootDir: string): Record<string, unknown> | null {
  const pkgPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Try to detect github_repo from git remote origin
 */
function detectGithubRepo(rootDir: string): string | null {
  try {
    const remote = execSync('git remote get-url origin', {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // Match github.com:user/repo.git or github.com/user/repo.git
    const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (match && match[1]) return match[1];
  } catch {
    // Not a git repo or no remote
  }
  return null;
}

/**
 * Detect the dev machine OS
 */
function detectServerOS(): 'mac' | 'ubuntu' | 'windows' {
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'windows';
  return 'ubuntu';
}

/**
 * Generate a smart stack.yml by auto-detecting project configuration.
 * Auto-detects: name, github_repo, pipeline, staging/prod, frameworks.
 * Uses EXAMPLE_ prefix for values that cannot be auto-detected (domains, ssl_email).
 */
export function generateSmartStackYml(rootDir: string): boolean {
  const outputPath = path.join(rootDir, STACK_CONFIG_FILENAME);

  // Read package.json for name and framework detection
  const pkg = readPackageJson(rootDir);
  const deps: Record<string, string> = {
    ...(pkg?.dependencies as Record<string, string> ?? {}),
    ...(pkg?.devDependencies as Record<string, string> ?? {}),
  };

  // Detect project name
  const pkgName = pkg?.name as string | undefined;
  const dirName = path.basename(rootDir);
  const name = (pkgName ?? dirName).replace(/[^a-z0-9-]/gi, '-').toLowerCase();

  // Detect github repo
  const githubRepo = detectGithubRepo(rootDir) ?? 'EXAMPLE_username/' + name;

  // Detect server OS for staging
  const devOS = detectServerOS();
  const stagingServer = devOS === 'windows' ? 'ubuntu' : devOS;

  // Build config
  const config: Record<string, unknown> = {
    name,
    config_version: '0.1.0',
    github_repo: githubRepo.startsWith('EXAMPLE_') ? githubRepo : githubRepo,
    ssl_email: 'EXAMPLE_admin@yourdomain.com',
    pipeline: 'factiii',

    ansible: {
      vault_path: 'group_vars/all/vault.yml',
      vault_password_file: '~/.vault_pass',
    },

    staging: {
      server: stagingServer,
      domain: 'EXAMPLE_staging.yourdomain.com',
      env_file: '.env.staging',
    },

    prod: {
      server: 'ubuntu',
      domain: 'EXAMPLE_yourdomain.com',
      env_file: '.env.prod',
    },
  };

  // Detect frameworks and add relevant config
  const detectedPlugins: string[] = [];
  if (deps['next']) detectedPlugins.push('nextjs');
  if (deps['prisma'] || deps['@prisma/client']) detectedPlugins.push('prisma');
  if (deps['@trpc/server']) detectedPlugins.push('trpc');
  if (deps['expo']) detectedPlugins.push('expo');

  // Build YAML content with comments
  const sections: string[] = [];

  sections.push('# Generated by @factiii/stack');
  sections.push('# Replace all EXAMPLE_ values with your actual configuration');
  sections.push('');

  // Dump main config
  sections.push(yaml.dump(config, { lineWidth: -1, noRefs: true }).trim());
  sections.push('');

  // Add detected plugins as a comment
  if (detectedPlugins.length > 0) {
    sections.push('# Detected frameworks: ' + detectedPlugins.join(', '));
    sections.push('');
  }

  // Add helpful comments
  sections.push('# ============================================================');
  sections.push('# NEXT STEPS');
  sections.push('# ============================================================');
  sections.push('#');
  sections.push('# 1. UPDATE THIS FILE');
  sections.push('#    Replace all values marked EXAMPLE_ with your actual values:');
  sections.push('#    - ssl_email: your real email for SSL certificates');
  sections.push('#    - staging.domain: your staging domain');
  sections.push('#    - prod.domain: your production domain');
  sections.push('#');
  sections.push('# 2. SET UP SECRETS');
  sections.push('#    npx stack init           -> creates vault, prompts for SSH keys & credentials');
  sections.push('#');
  sections.push('# 3. SCAN FOR ISSUES');
  sections.push('#    npx stack scan           -> checks everything, reports what is missing (changes nothing)');
  sections.push('#');
  sections.push('# 4. AUTO-FIX ISSUES');
  sections.push('#    npx stack fix            -> installs tools, creates config files, fixes what it can');
  sections.push('#                                (does NOT touch docker/nginx - those are handled by deploy)');
  sections.push('#');
  sections.push('# 5. DEPLOY');
  sections.push('#    npx stack deploy --staging --dry-run   -> preview what will happen');
  sections.push('#    npx stack deploy --staging             -> deploy to staging');
  sections.push('#    npx stack deploy --prod                -> deploy to production');
  sections.push('#');
  sections.push('# ============================================================');
  sections.push('');

  const finalContent = sections.join('\n');
  fs.writeFileSync(outputPath, finalContent);

  console.log('[OK] Created ' + STACK_CONFIG_FILENAME + ' (auto-detected: ' + name + ')');

  if (detectedPlugins.length > 0) {
    console.log('     Detected: ' + detectedPlugins.join(', '));
  }

  return true;
}
