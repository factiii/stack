/**
 * Docker Fixes
 *
 * Ensures Docker and Docker Compose are installed on staging and production servers.
 * Runs before container-dependent fixes so deployments don't crash.
 *
 * - Staging (Mac): checks for Docker Desktop or Colima
 * - Prod (Ubuntu/EC2): installs via get.docker.com
 */

import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { isOnServer } from '../utils/aws-helpers.js';
import { extractEnvironments } from '../../../../utils/config-helpers.js';
import { sshExec, findSshKeyForStage } from '../../../../utils/ssh-helper.js';

export const dockerFixes: Fix[] = [
  {
    id: 'docker-not-installed-staging',
    stage: 'staging',
    severity: 'critical',
    description: '🐳 Docker not installed on staging server',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (isOnServer()) return false;

      const environments = extractEnvironments(config);
      const stagingEnv = environments.staging;
      if (!stagingEnv?.domain || stagingEnv.domain.toUpperCase().startsWith('EXAMPLE')) return false;
      if (!findSshKeyForStage('staging', config.name)) return false;

      try {
        await sshExec(stagingEnv, 'docker --version', 'staging', config);
        return false;
      } catch {
        return true;
      }
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const environments = extractEnvironments(config);
      const stagingEnv = environments.staging;
      if (!stagingEnv?.domain) return false;

      const server = stagingEnv.server ?? 'mac';

      try {
        if (server === 'mac') {
          console.log('   Installing Docker on Mac staging server...');
          // Try Colima first (lightweight, no Docker Desktop license needed)
          await sshExec(stagingEnv,
            'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && ' +
            'which docker >/dev/null 2>&1 || (' +
            'brew install docker docker-compose colima 2>/dev/null && ' +
            'colima start --memory 4 --cpu 2' +
            ')',
            'staging', config
          );
        } else {
          console.log('   Installing Docker on staging server...');
          await sshExec(stagingEnv,
            'sudo apt-get update -qq && ' +
            'curl -fsSL https://get.docker.com | sh && ' +
            'sudo usermod -aG docker $USER && ' +
            'sudo systemctl enable docker && sudo systemctl start docker',
            'staging', config
          );
        }

        // Verify
        const version = await sshExec(stagingEnv, 'docker --version', 'staging', config);
        console.log('   [OK] ' + version.trim());
        return true;
      } catch (e) {
        console.log('   [!] Failed to install Docker: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Install Docker on the staging server:\n' +
      '  Mac: brew install docker docker-compose colima && colima start\n' +
      '  Ubuntu: curl -fsSL https://get.docker.com | sh',
  },
  {
    id: 'docker-not-installed-prod',
    stage: 'prod',
    severity: 'critical',
    description: '🐳 Docker not installed on production server',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (isOnServer()) return false;

      const environments = extractEnvironments(config);
      const prodEnv = environments.prod ?? environments.production;
      if (!prodEnv?.domain || prodEnv.domain.toUpperCase().startsWith('EXAMPLE')) return false;
      if (!findSshKeyForStage('prod', config.name)) return false;

      try {
        await sshExec(prodEnv, 'docker compose version', 'prod', config);
        return false;
      } catch {
        return true;
      }
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const environments = extractEnvironments(config);
      const prodEnv = environments.prod ?? environments.production;
      if (!prodEnv?.domain) return false;

      try {
        console.log('   Installing Docker on production server...');
        await sshExec(prodEnv,
          'sudo apt-get update -qq && ' +
          'curl -fsSL https://get.docker.com | sh && ' +
          'sudo usermod -aG docker $USER && ' +
          'sudo systemctl enable docker && sudo systemctl start docker',
          'prod', config
        );
        console.log('   [OK] Docker installed');

        const version = await sshExec(prodEnv, 'sudo docker compose version', 'prod', config);
        console.log('   [OK] ' + version.trim());
        return true;
      } catch (e) {
        console.log('   [!] Failed to install Docker: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Install Docker on the EC2 instance:\n' +
      '  ssh ubuntu@<ec2-ip> "curl -fsSL https://get.docker.com | sh"',
  },
];
