/**
 * Ubuntu Platform Commands
 *
 * Command sets for Ubuntu/Debian (uses apt-get).
 */

import type { PlatformCommands } from '../types.js';

export const dockerCommands: PlatformCommands = {
  check: 'which docker',
  install:
    'sudo apt-get update && sudo apt-get install -y docker.io && sudo systemctl enable docker && sudo systemctl start docker && sudo usermod -aG docker $USER',
  start: 'sudo systemctl start docker',
  manualFix: 'Install Docker: curl -fsSL https://get.docker.com | sh',
};

export const nodeCommands: PlatformCommands = {
  check: 'which node',
  install: 'sudo apt-get update && sudo apt-get install -y nodejs npm',
  manualFix: 'Install Node.js: sudo apt-get install -y nodejs npm',
};

export const gitCommands: PlatformCommands = {
  check: 'which git',
  install: 'sudo apt-get update && sudo apt-get install -y git',
  manualFix: 'Install Git: sudo apt-get install -y git',
};

export const pnpmCommands: PlatformCommands = {
  check: 'which pnpm',
  install: 'npm install -g pnpm',
  manualFix: 'Install pnpm: npm install -g pnpm',
};
