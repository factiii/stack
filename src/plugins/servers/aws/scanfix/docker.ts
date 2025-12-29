/**
 * Docker-related fixes for AWS plugin
 * Handles Docker installation and running status for dev and prod environments
 */

import { execSync } from 'child_process';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';

export const dockerFixes: Fix[] = [
  // DEV STAGE FIXES
  {
    id: 'aws-docker-not-installed-dev',
    stage: 'dev',
    severity: 'critical',
    description: 'Docker is not installed locally',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        execSync('which docker', { stdio: 'pipe' });
        return false;
      } catch {
        return true;
      }
    },
    fix: null,
    manualFix: 'Install Docker Desktop: https://www.docker.com/products/docker-desktop/',
  },
  {
    id: 'aws-docker-not-running-dev',
    stage: 'dev',
    severity: 'critical',
    description: 'Docker is not running locally',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        execSync('docker info', { stdio: 'pipe' });
        return false;
      } catch {
        return true;
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        console.log('Starting Docker Desktop...');
        execSync('open -a Docker', { stdio: 'inherit' });
        
        // Wait for Docker to start (up to 30 seconds)
        for (let i = 0; i < 30; i++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          try {
            execSync('docker info', { stdio: 'pipe' });
            console.log('✅ Docker started successfully');
            return true;
          } catch {
            // Still starting...
          }
        }
        
        console.log('⏳ Docker is starting (may take a minute)...');
        return true; // Consider it fixed, even if still starting
      } catch (error) {
        console.error('Failed to start Docker:', error);
        return false;
      }
    },
    manualFix: 'Start Docker Desktop',
  },

  // PROD STAGE FIXES
  {
    id: 'prod-docker-missing',
    stage: 'prod',
    severity: 'critical',
    description: 'Docker not installed on production server',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // Only check if prod environment is defined in config
      const envConfig =
        config?.environments?.prod ?? config?.environments?.production;
      if (!envConfig) return false; // Skip check if prod not configured
      if (!envConfig?.host) return false;

      // Executed locally - SSH handled by CLI wrapper
      try {
        execSync('which docker', { stdio: 'pipe' });
        return false;
      } catch {
        return true;
      }
    },
    fix: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // Executed locally - SSH handled by CLI wrapper
      console.log('   Installing Docker on production server...');
      const envConfig =
        config?.environments?.prod ?? config?.environments?.production;
      if (!envConfig) return false;
      
      try {
        execSync(
          'sudo apt-get update && sudo apt-get install -y docker.io && sudo systemctl enable docker && sudo systemctl start docker && sudo usermod -aG docker $USER',
          { stdio: 'inherit' }
        );
        return true;
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.log(`   Failed: ${errorMessage}`);
        return false;
      }
    },
    manualFix: 'SSH to server and install Docker: curl -fsSL https://get.docker.com | sh',
  },
];

