/**
 * Certbot-related fixes for Mac Mini plugin
 * Handles certbot installation and SSL certificate management for staging
 */

import { execSync } from 'child_process';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';

export const certbotFixes: Fix[] = [
  {
    id: 'staging-certbot-missing',
    stage: 'staging',
    severity: 'critical',
    description: 'Certbot not installed on staging server',
    scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      try {
        execSync('which certbot', { stdio: 'pipe' });
        return false; // No problem - certbot exists
      } catch {
        return true; // Problem - certbot missing
      }
    },
    fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      console.log('   Installing Certbot...');

      // Check if we're on Mac or Linux
      const isMac = process.platform === 'darwin';

      try {
        if (isMac) {
          // Mac - use Homebrew
          console.log('   Detected macOS, using Homebrew...');
          try {
            execSync('which brew', { stdio: 'pipe' });
          } catch {
            console.log('   ❌ Homebrew not found. Please install Homebrew first:');
            console.log('      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"');
            return false;
          }

          execSync('brew install certbot', {
            stdio: 'inherit',
            env: {
              ...process.env,
              PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
            },
          });
        } else {
          // Linux - use apt-get
          console.log('   Detected Linux, using apt-get...');
          execSync('sudo apt-get update && sudo apt-get install -y certbot python3-certbot-nginx', {
            stdio: 'inherit',
          });
        }

        // Verify installation
        console.log('   Verifying installation...');
        execSync('which certbot', { stdio: 'pipe' });
        console.log('   ✅ Certbot installed successfully');
        return true;
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.log(`   ❌ Installation failed: ${errorMessage}`);
        console.log('   Please install manually or check permissions');
        return false;
      }
    },
    manualFix: 'SSH to staging server and install certbot: brew install certbot (Mac) or sudo apt-get install certbot (Linux)',
  },
];
