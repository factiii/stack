/**
 * Generate stack.yml
 *
 * Generates the stack.yml configuration file from plugin schemas.
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

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
    name: 'EXAMPLE-your-repo-name',
    config_version: '0.1.0',
    github_repo: 'EXAMPLE-username/repo-name',
    ssl_email: 'EXAMPLE-admin@yourdomain.com',
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
      domain: 'EXAMPLE-staging.yourdomain.com',  // Used for nginx AND SSH
      env_file: '.env.staging',
    },

    prod: {
      server: 'ubuntu',  // Server OS type
      pipeline: 'aws',   // Use AWS pipeline for deployment
      domain: 'EXAMPLE-yourdomain.com',  // Used for nginx AND SSH

      // AWS-specific config (when server: aws)
      config: 'free-tier', // Options: ec2, free-tier, standard, enterprise
      access_key_id: 'EXAMPLE-AKIAXXXXXXXX',
      region: 'us-east-1',

      // Plugin configs for this environment
      plugins: {
        ecr: {
          ecr_registry: 'EXAMPLE-123456789012.dkr.ecr.us-east-1.amazonaws.com',
          ecr_repository: 'EXAMPLE-repo-name',
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
#   access_key_id: EXAMPLE-AKIAXXXXXXXX
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
  console.log('\nNEXT STEPS:\n');
  console.log('  1. Configure your project:');
  console.log('     [ ] Replace all EXAMPLE- values in ' + STACK_CONFIG_FILENAME);
  console.log('         - name, github_repo, ssl_email, domains\n');
  console.log('  2. Set up secrets (requires ansible-vault):');
  console.log('     [ ] Generate SSH key:  ssh-keygen -t ed25519 -f ~/.ssh/staging_deploy_key');
  console.log('     [ ] Store in vault:    npx factiii secrets set STAGING_SSH');
  console.log('     [ ] Add public key to server: ssh-copy-id -i ~/.ssh/staging_deploy_key.pub user@host\n');
  console.log('  3. Validate and fix:');
  console.log('     [ ] npx factiii scan          (check for issues)');
  console.log('     [ ] npx factiii fix           (auto-fix what it can)\n');
  console.log('  4. Deploy:');
  console.log('     [ ] npx factiii deploy --staging --dry-run   (preview)');
  console.log('     [ ] npx factiii deploy --staging             (deploy)\n');

  return true;
}
