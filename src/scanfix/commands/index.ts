/**
 * Platform Commands Index
 *
 * Exports command sets for each platform.
 */

import type { Platform, ToolCommands } from '../types.js';
import * as mac from './mac.js';
import * as ubuntu from './ubuntu.js';

/**
 * Windows commands - placeholder for future implementation
 */
const windowsPlaceholder = {
  check: 'where docker',
  install: undefined,
  manualFix: 'Install manually from official website',
};

/**
 * Docker commands by platform
 */
export const dockerCommands: ToolCommands = {
  mac: mac.dockerCommands,
  ubuntu: ubuntu.dockerCommands,
  windows: { ...windowsPlaceholder, check: 'where docker', manualFix: 'Install Docker Desktop from https://www.docker.com/products/docker-desktop/' },
};

/**
 * Node.js commands by platform
 */
export const nodeCommands: ToolCommands = {
  mac: mac.nodeCommands,
  ubuntu: ubuntu.nodeCommands,
  windows: { ...windowsPlaceholder, check: 'where node', manualFix: 'Install Node.js from https://nodejs.org/' },
};

/**
 * Git commands by platform
 */
export const gitCommands: ToolCommands = {
  mac: mac.gitCommands,
  ubuntu: ubuntu.gitCommands,
  windows: { ...windowsPlaceholder, check: 'where git', manualFix: 'Install Git from https://git-scm.com/' },
};

/**
 * pnpm commands by platform
 */
export const pnpmCommands: ToolCommands = {
  mac: mac.pnpmCommands,
  ubuntu: ubuntu.pnpmCommands,
  windows: { check: 'where pnpm', install: 'npm install -g pnpm', manualFix: 'Install pnpm: npm install -g pnpm' },
};

/**
 * Get commands for a specific tool and platform
 */
export function getCommands(
  tool: 'docker' | 'node' | 'git' | 'pnpm',
  platform: Platform
) {
  const commandSets: Record<string, ToolCommands> = {
    docker: dockerCommands,
    node: nodeCommands,
    git: gitCommands,
    pnpm: pnpmCommands,
  };
  return commandSets[tool]?.[platform];
}
