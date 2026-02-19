/**
 * Generate stackAuto.yml
 *
 * Generates the stackAuto.yml configuration file with auto-detected values.
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

import { STACK_AUTO_FILENAME, getStackAutoPath } from '../constants/config-files.js';

interface DetectedConfig {
  has_prisma?: boolean;
  has_trpc?: boolean;
  prisma_schema?: string;
  prisma_version?: string;
  dockerfile?: string;
  package_manager?: string;
  node_version?: string;
  pnpm_version?: string;
  aws_cli_installed?: boolean;
  [key: string]: unknown;
}

interface PluginWithDetect {
  id?: string;
  detectConfig?: (rootDir: string) => Promise<DetectedConfig>;
}

interface GenerateAutoOptions {
  plugins?: PluginWithDetect[];
  force?: boolean;
}

/**
 * Get Factiii package version
 */
function getFactiiiVersion(): string {
  try {
    const packageJsonPath = path.join(__dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: string };
    return pkg.version ?? '1.0.0';
  } catch {
    return '1.0.0';
  }
}

/**
 * Load all plugins
 */
function loadAllPlugins(): PluginWithDetect[] {
  const plugins: PluginWithDetect[] = [];

  // Load pipeline plugins
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const FactiiiPipeline = require('../plugins/pipelines/factiii') as PluginWithDetect;
    plugins.push(FactiiiPipeline);
  } catch {
    // Plugin not available
  }

  // Load server plugins
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const MacPlugin = require('../plugins/servers/mac') as PluginWithDetect;
    plugins.push(MacPlugin);
  } catch {
    // Plugin not available
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const UbuntuPlugin = require('../plugins/servers/ubuntu') as PluginWithDetect;
    plugins.push(UbuntuPlugin);
  } catch {
    // Plugin not available
  }

  // Load pipeline plugins (AWS is now a pipeline, not a server)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AWSPipeline = require('../plugins/pipelines/aws') as PluginWithDetect;
    plugins.push(AWSPipeline);
  } catch {
    // Plugin not available
  }

  // Load framework plugins
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const PrismaTrpcPlugin = require('../plugins/frameworks/prisma-trpc') as PluginWithDetect;
    plugins.push(PrismaTrpcPlugin);
  } catch {
    // Plugin not available
  }

  return plugins;
}

/**
 * Generate stackAuto.yml with auto-detected values from plugins
 */
export async function generateFactiiiAuto(
  rootDir: string,
  options: GenerateAutoOptions = {}
): Promise<void> {
  const outputPath = path.join(rootDir, STACK_AUTO_FILENAME);

  console.log('🔍 Auto-detecting project configuration...\n');

  // Use provided plugins or load all
  const plugins = options.plugins ?? loadAllPlugins();
  const autoConfig: Record<string, unknown> = {
    factiii_version: getFactiiiVersion(),
    factiii_min_version: getFactiiiVersion(),
  };

  // Collect auto-detected config from each plugin
  for (const PluginClass of plugins) {
    if (PluginClass.detectConfig) {
      try {
        const detected = await PluginClass.detectConfig(rootDir);
        if (detected) {
          Object.assign(autoConfig, detected);

          // Log what was detected
          if (PluginClass.id === 'prisma-trpc' && detected.has_prisma) {
            console.log(`   ✅ Prisma detected`);
            if (detected.prisma_schema) console.log(`      Schema: ${detected.prisma_schema}`);
            if (detected.prisma_version) console.log(`      Version: ${detected.prisma_version}`);
          }
          if (PluginClass.id === 'prisma-trpc' && detected.has_trpc) {
            console.log(`   ✅ tRPC detected`);
          }
          if (PluginClass.id === 'factiii' && detected.dockerfile) {
            console.log(`   ✅ Dockerfile: ${detected.dockerfile}`);
          }
          if (PluginClass.id === 'factiii' && detected.package_manager) {
            console.log(`   📦 Package manager: ${detected.package_manager}`);
          }
          if (PluginClass.id === 'factiii' && detected.node_version) {
            console.log(`   📦 Node version: ${detected.node_version}`);
          }
          if (PluginClass.id === 'factiii' && detected.pnpm_version) {
            console.log(`   📦 pnpm version: ${detected.pnpm_version}`);
          }
          if (PluginClass.id === 'aws' && detected.aws_cli_installed) {
            console.log(`   ✅ AWS CLI installed`);
          }
        }
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.log(`   ⚠️  Error detecting ${PluginClass.id}: ${errorMessage}`);
      }
    }
  }

  // Ensure ssh_user is always present (defaults to ubuntu)
  if (!autoConfig.ssh_user) {
    autoConfig.ssh_user = 'ubuntu';
  }

  // Organize config into sections for better readability
  const versionSection: Record<string, unknown> = {};
  const stackSection: Record<string, unknown> = {};
  const sshSection: Record<string, unknown> = {};
  const buildSection: Record<string, unknown> = {};
  const otherSection: Record<string, unknown> = {};

  // Categorize fields
  for (const [key, value] of Object.entries(autoConfig)) {
    if (key.startsWith('factiii_')) {
      versionSection[key] = value;
    } else if (key.startsWith('has_')) {
      stackSection[key] = value;
    } else if (key === 'ssh_user') {
      sshSection[key] = value;
    } else if (['dockerfile', 'package_manager', 'node_version', 'pnpm_version'].includes(key)) {
      buildSection[key] = value;
    } else {
      otherSection[key] = value;
    }
  }

  // Build YAML with sections
  const sections: string[] = [];

  // Header
  sections.push(
    '# Auto-detected configuration',
    '# Generated by: npx factiii',
    '# To override values, add: value OVERRIDE newvalue',
    ''
  );

  // Version section
  if (Object.keys(versionSection).length > 0) {
    sections.push('# Factiii version tracking');
    sections.push(yaml.dump(versionSection, { lineWidth: -1, noRefs: true }).trim());
    sections.push('');
  }

  // Stack detection section
  if (Object.keys(stackSection).length > 0) {
    sections.push('# Detected stack components');
    sections.push(yaml.dump(stackSection, { lineWidth: -1, noRefs: true }).trim());
    sections.push('');
  }

  // SSH configuration section
  if (Object.keys(sshSection).length > 0) {
    sections.push('# SSH configuration');
    sections.push('# Default SSH user for all environments (override with: ubuntu OVERRIDE admin)');
    sections.push(yaml.dump(sshSection, { lineWidth: -1, noRefs: true }).trim());
    sections.push('');
  }

  // Build configuration section
  if (Object.keys(buildSection).length > 0) {
    sections.push('# Build configuration');
    sections.push(yaml.dump(buildSection, { lineWidth: -1, noRefs: true }).trim());
    sections.push('');
  }

  // Other fields
  if (Object.keys(otherSection).length > 0) {
    sections.push(yaml.dump(otherSection, { lineWidth: -1, noRefs: true }).trim());
  }

  const finalContent = sections.join('\n');

  // Check if file exists and content changed (check both new and legacy paths)
  const existingPath = getStackAutoPath(rootDir);
  const exists = fs.existsSync(existingPath);
  if (exists) {
    const existingContent = fs.readFileSync(existingPath, 'utf8');
    if (existingContent === finalContent) {
      console.log('\n⏭️  ' + STACK_AUTO_FILENAME + ' unchanged');
      return;
    }
    // If file exists and content changed, only update if force is true
    // (init.ts handles prompting, so if we get here with force=false, skip)
    if (options.force === false) {
      console.log('\n⏭️  ' + STACK_AUTO_FILENAME + ' would be updated, but overwrite was declined');
      return;
    }
  }

  // Write file
  fs.writeFileSync(outputPath, finalContent);

  if (exists) {
    console.log('\n🔄 Updated ' + STACK_AUTO_FILENAME);
  } else {
    console.log('\n✅ Created ' + STACK_AUTO_FILENAME);
  }
}
