/**
 * Container management fixes for macOS plugin
 * Handles unmanaged container detection and cleanup
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import yaml from 'js-yaml';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';

export const containerFixes: Fix[] = [
  {
    id: 'staging-old-containers',
    stage: 'staging',
    severity: 'warning',
    description: '🐳 Unmanaged Docker containers found (not in docker-compose.yml)',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const hasStagingEnv = config?.environments?.staging;
      if (!hasStagingEnv) return false;

      try {
        // 1. Generate configs first to know what SHOULD be running
        const factiiiDir = path.join(process.env.HOME ?? '/Users/jon', '.factiii');
        const infraDir = path.join(factiiiDir, 'infrastructure');
        const generateScript = path.join(infraDir, 'dist', 'scripts', 'generate-all.js');

        if (fs.existsSync(generateScript)) {
          execSync(`node "${generateScript}"`, { stdio: 'pipe', cwd: factiiiDir });
        }

        // 2. Get list of managed containers from generated docker-compose.yml
        const composeFile = path.join(factiiiDir, 'docker-compose.yml');
        if (!fs.existsSync(composeFile)) {
          return false; // No compose file, nothing to check
        }

        const composeContent = fs.readFileSync(composeFile, 'utf8');
        const compose = yaml.load(composeContent) as {
          services?: Record<string, { container_name?: string }>;
        };
        
        // Extract managed container names: service names + container_name values
        const managedContainers = new Set<string>();
        if (compose.services) {
          for (const [serviceName, service] of Object.entries(compose.services)) {
            // Add service name (default container name if container_name not specified)
            managedContainers.add(serviceName);
            // Add explicit container_name if specified
            if (service.container_name) {
              managedContainers.add(service.container_name);
            }
          }
        }

        // 3. Get running containers
        const running = execSync('docker ps --format "{{.Names}}"', { encoding: 'utf8' })
          .split('\n')
          .filter(Boolean);

        // 4. Find unmanaged containers (only exclude those in docker-compose.yml or container_exclusions)
        const exclusions = config.container_exclusions ?? [];
        const unmanaged = running.filter(
          (name) =>
            !managedContainers.has(name) &&
            !exclusions.includes(name)
        );

        if (unmanaged.length > 0) {
          // Log detailed message with container names
          console.log(`\n⚠️  Found ${unmanaged.length} unmanaged container${unmanaged.length > 1 ? 's' : ''}:`);
          for (const container of unmanaged) {
            console.log(`   - ${container}`);
          }

          // Generate YAML snippet
          const yamlSnippet = `container_exclusions:\n  - ${unmanaged.join('\n  - ')}`;

          console.log('\n💡 To keep these containers running, add to stack.yml:\n');
          console.log(yamlSnippet);
        }

        return unmanaged.length > 0;
      } catch {
        return false; // If we can't check, assume no problem
      }
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      try {
        // Same logic as scan to find unmanaged containers
        const factiiiDir = path.join(process.env.HOME ?? '/Users/jon', '.factiii');
        const infraDir = path.join(factiiiDir, 'infrastructure');
        const generateScript = path.join(infraDir, 'dist', 'scripts', 'generate-all.js');

        if (fs.existsSync(generateScript)) {
          console.log('   🔨 Generating configs to determine managed containers...');
          execSync(`node "${generateScript}"`, { stdio: 'inherit', cwd: factiiiDir });
        }

        const composeFile = path.join(factiiiDir, 'docker-compose.yml');
        if (!fs.existsSync(composeFile)) {
          console.log('   ⚠️  No docker-compose.yml found, skipping cleanup');
          return false;
        }

        const composeContent = fs.readFileSync(composeFile, 'utf8');
        const compose = yaml.load(composeContent) as {
          services?: Record<string, { container_name?: string }>;
        };
        
        // Extract managed container names: service names + container_name values
        const managedContainers = new Set<string>();
        if (compose.services) {
          for (const [serviceName, service] of Object.entries(compose.services)) {
            // Add service name (default container name if container_name not specified)
            managedContainers.add(serviceName);
            // Add explicit container_name if specified
            if (service.container_name) {
              managedContainers.add(service.container_name);
            }
          }
        }

        const running = execSync('docker ps --format "{{.Names}}"', { encoding: 'utf8' })
          .split('\n')
          .filter(Boolean);

        // Find unmanaged containers (only exclude those in docker-compose.yml or container_exclusions)
        const exclusions = config.container_exclusions ?? [];
        const unmanaged = running.filter(
          (name) =>
            !managedContainers.has(name) &&
            !exclusions.includes(name)
        );

        if (unmanaged.length === 0) {
          console.log('   ✅ No unmanaged containers found');
          return true;
        }

        console.log(`   🧹 Stopping ${unmanaged.length} unmanaged container(s):`);
        for (const container of unmanaged) {
          console.log(`      - ${container}`);
          execSync(`docker stop "${container}"`, { stdio: 'inherit' });
        }

        console.log('   ✅ Cleanup complete');
        return true;
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.log(`   Failed to clean up containers: ${errorMessage}`);
        return false;
      }
    },
    manualFix: 'Run: npx stack fix --staging (will stop unmanaged containers). To keep specific containers running, add them to container_exclusions in stack.yml',
  },
];

