/**
 * Generate factiii.yml
 *
 * Generates the factiii.yml configuration file from plugin schemas.
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

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
    const MacMiniPlugin = require('../plugins/servers/mac-mini') as PluginWithSchema;
    plugins.push(MacMiniPlugin);
  } catch {
    // Plugin not available
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AWSPlugin = require('../plugins/servers/aws') as PluginWithSchema;
    plugins.push(AWSPlugin);
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
 * Generate factiii.yml template from plugin schemas
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

    // Optional config fields
    prisma_schema: null, // Optional: override auto-detected schema path
    prisma_version: null, // Optional: override auto-detected version

    // ============================================================
    // ENVIRONMENTS (top-level keys)
    // ============================================================
    staging: {
      server: 'mac-mini',  // Server plugin to use
      domain: 'EXAMPLE-staging.yourdomain.com',  // Used for nginx AND SSH
      env_file: '.env.staging',
    },

    prod: {
      server: 'aws',  // Server plugin to use
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
#   server: mac-mini
#   domain: staging2.yourdomain.com
#   env_file: .env.staging2
#
# Example - Additional prod environment:
# prod2:
#   server: aws
#   domain: app2.yourdomain.com
#   config: free-tier
#   access_key_id: EXAMPLE-AKIAXXXXXXXX
#   region: us-west-2

# ============================================================
# ENVIRONMENT OPTIONS
# ============================================================
# All environments support these optional fields:
#   ssh_user: ubuntu  # Override SSH user (defaults to factiiiAuto.yml ssh_user)
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
 * Generate factiii.yml file in the target directory
 */
export function generateFactiiiYml(rootDir: string, options: GenerateOptions = {}): boolean {
  const outputPath = path.join(rootDir, 'factiii.yml');

  // Check if file already exists
  if (fs.existsSync(outputPath) && !options.force) {
    console.log('⏭️  factiii.yml already exists (use --force to overwrite)');
    return false;
  }

  // Use provided plugins or load all
  const content = generateFactiiiYmlTemplate(options.plugins ?? null);

  // Write file
  fs.writeFileSync(outputPath, content);

  console.log('✅ Created factiii.yml');
  console.log('\n💡 Next steps:');
  console.log('   1. Replace EXAMPLE- values with your actual values');
  console.log('   2. Run: npx factiii scan');
  console.log('   3. Run: npx factiii fix\n');

  return true;
}

