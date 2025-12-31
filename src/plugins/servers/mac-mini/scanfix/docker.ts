/**
 * Docker-related fixes for Mac Mini plugin
 * Handles Docker installation, running status, and autostart configuration
 */

import * as fs from 'fs';
import { execSync } from 'child_process';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';

export const dockerFixes: Fix[] = [
  // DEV STAGE FIXES
  {
    id: 'docker-not-installed-dev',
    stage: 'dev',
    severity: 'critical',
    description: 'Docker is not installed locally',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        execSync('which docker', { stdio: 'pipe' });
        return false; // No problem
      } catch {
        return true; // Problem exists
      }
    },
    fix: null,
    manualFix: 'Install Docker Desktop: https://www.docker.com/products/docker-desktop/',
  },
  {
    id: 'docker-not-running-dev',
    stage: 'dev',
    severity: 'critical',
    description: 'Docker is not running locally',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        execSync('docker info', { stdio: 'pipe' });
        return false; // No problem
      } catch {
        return true; // Problem exists
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        // Double-check Docker isn't already running
        try {
          execSync('docker info', { stdio: 'pipe' });
          console.log('✅ Docker is already running');
          return true; // Already running, nothing to fix
        } catch {
          // Docker not running, proceed to start it
        }
        
        console.log('🐳 Starting Docker Desktop...');
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
        
        console.log('❌ Docker failed to start within 30 seconds');
        console.log('💡 Try starting Docker Desktop manually');
        return false; // Failed to start
      } catch (error) {
        console.error('❌ Failed to start Docker:', error);
        return false;
      }
    },
    manualFix: 'Start Docker Desktop or run: open -a Docker',
  },

  // STAGING STAGE FIXES
  // ============================================================
  // CRITICAL: NO SSH IN FIX FUNCTIONS
  // ============================================================
  // SSH keys for staging/prod are ONLY in GitHub Secrets, NOT on dev machines.
  // Dev machine CANNOT SSH to staging/prod.
  // Workflows SSH ONCE and run CLI with --staging or --prod flag.
  // When GITHUB_ACTIONS=true, pipeline returns 'local' for staging/prod.
  // NEVER add SSH calls to individual fix functions.
  // CLI handles execution context by asking pipeline canReach().
  // ============================================================
  {
    id: 'staging-docker-missing',
    stage: 'staging',
    severity: 'critical',
    description: 'Docker not installed on staging server',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // Only check if staging environment is defined in config
      const hasStagingEnv = config?.environments?.staging;
      if (!hasStagingEnv) return false; // Skip check if staging not configured

      const domain = config?.environments?.staging?.domain;
      if (!domain) return false;

      // Executed locally - SSH handled by CLI wrapper
      try {
        execSync('which docker', { stdio: 'pipe' });
        return false; // Docker is installed
      } catch {
        return true; // Docker is not installed
      }
    },
    fix: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // Executed locally - SSH handled by CLI wrapper
      console.log('   Installing Docker on staging server...');
      try {
        execSync('brew install --cask docker || (curl -fsSL https://get.docker.com | sh)', { stdio: 'inherit' });
        return true;
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.log(`   Failed: ${errorMessage}`);
        return false;
      }
    },
    manualFix: 'SSH to server and install Docker: brew install --cask docker',
  },
  {
    id: 'staging-docker-not-running',
    stage: 'staging',
    severity: 'critical',
    description: 'Docker is not running on staging server',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // Only check if staging environment is defined in config
      const hasStagingEnv = config?.environments?.staging;
      if (!hasStagingEnv) return false; // Skip check if staging not configured

      const domain = config?.environments?.staging?.domain;
      if (!domain) return false;

      // Executed locally - SSH handled by CLI wrapper
      try {
        execSync('docker info', { stdio: 'pipe' });
        return false; // Docker is running
      } catch {
        return true; // Docker is not running
      }
    },
    fix: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // Executed locally - SSH handled by CLI wrapper
      try {
        // Double-check Docker isn't already running
        try {
          execSync('docker info', { stdio: 'pipe' });
          console.log('   ✅ Docker is already running');
          return true;
        } catch {
          // Docker not running, proceed to start it
        }
        
        console.log('   🐳 Starting Docker Desktop on staging server...');
        execSync('open -a Docker && sleep 15 && docker info', { stdio: 'inherit' });
        console.log('   ✅ Docker Desktop started successfully');
        return true;
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.log(`   ❌ Failed to start Docker: ${errorMessage}`);
        return false;
      }
    },
    manualFix: 'SSH to server and run: open -a Docker',
  },
  {
    id: 'staging-docker-autostart',
    stage: 'staging',
    severity: 'warning',
    description: 'Docker not configured to start on login',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      // Only check if staging environment is defined in config
      const hasStagingEnv = config?.environments?.staging;
      if (!hasStagingEnv) return false; // Skip check if staging not configured

      const domain = config?.environments?.staging?.domain;
      if (!domain) return false;

      // If Docker is running, don't worry about autostart config
      try {
        execSync('docker info', { stdio: 'pipe', timeout: 5000 });
        return false; // Docker is running, no need to check autostart
      } catch {
        // Docker not running, check if it's configured to autostart
      }

      // Check LaunchAgents plist file instead of using AppleScript
      // AppleScript doesn't work reliably over SSH (no GUI access)
      try {
        const homeDir = process.env.HOME ?? '/Users/jon';
        const plistPath = `${homeDir}/Library/LaunchAgents/com.docker.helper.plist`;
        return !fs.existsSync(plistPath);
      } catch {
        // If we can't check, assume it's not a problem
        return false;
      }
    },
    fix: null, // Cannot reliably fix via SSH - requires GUI access
    manualFix:
      'Add Docker to Login Items: System Settings → General → Login Items → Add Docker',
  },
];

