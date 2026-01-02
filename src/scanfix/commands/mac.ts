/**
 * Mac Platform Commands
 *
 * Command sets for macOS (uses Homebrew).
 */

import type { PlatformCommands } from '../types.js';

export const dockerCommands: PlatformCommands = {
  check: 'which docker',
  // Docker Desktop must be installed manually on Mac
  install: undefined,
  start: 'open -a Docker',
  manualFix: 'Install Docker Desktop: https://www.docker.com/products/docker-desktop/',
};

export const nodeCommands: PlatformCommands = {
  check: 'which node',
  install: 'brew install node',
  manualFix: 'Install Node.js: brew install node',
};

export const gitCommands: PlatformCommands = {
  check: 'which git',
  install: 'brew install git',
  manualFix: 'Install Git: brew install git',
};

export const pnpmCommands: PlatformCommands = {
  check: 'which pnpm',
  install: 'npm install -g pnpm',
  manualFix: 'Install pnpm: npm install -g pnpm',
};
