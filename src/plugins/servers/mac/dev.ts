/**
 * Dev environment operations for macOS plugin
 * Handles local development deployment
 */

import * as fs from 'fs';
import { execSync } from 'child_process';
import type { DeployResult } from '../../../types/index.js';

/**
 * Deploy to local dev environment
 */
export async function deployDev(): Promise<DeployResult> {
  console.log('   Starting local dev containers...');

  try {
    // Check for docker-compose file
    const composeFile = fs.existsSync('docker-compose.yml')
      ? 'docker-compose.yml'
      : fs.existsSync('compose.yml')
        ? 'compose.yml'
        : null;

    if (composeFile) {
      execSync(`docker compose -f ${composeFile} up -d`, { stdio: 'inherit' });
      return { success: true, message: 'Local containers started' };
    } else {
      console.log('   No docker-compose.yml found, skipping container start');
      return { success: true, message: 'No compose file, skipped' };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
