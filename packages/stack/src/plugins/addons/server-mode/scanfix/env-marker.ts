/**
 * Environment Marker Scanfix
 *
 * Writes /etc/factiii/environment on servers so you can identify
 * which environment you're on when SSH'd in.
 *
 * Usage after setup:
 *   cat /etc/factiii/environment     → "staging" or "prod"
 *   factiii-env                      → prints environment name
 *
 * Also sets PS1 prompt coloring:
 *   staging = yellow prompt
 *   prod    = red prompt
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import type { Fix, FactiiiConfig } from '../../../../types/index.js';

const MARKER_PATH = '/etc/factiii/environment';
const PROFILE_MARKER = '# factiii-env-prompt';

function getCurrentMarker(): string | null {
  try {
    return fs.readFileSync(MARKER_PATH, 'utf8').trim();
  } catch {
    // Try via sudo (file may be root-owned)
    try {
      return execSync('sudo cat ' + MARKER_PATH + ' 2>/dev/null', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return null;
    }
  }
}

function hasPromptMarker(): boolean {
  try {
    const profilePaths = [
      process.env.HOME + '/.bashrc',
      process.env.HOME + '/.zshrc',
    ];
    for (const p of profilePaths) {
      try {
        const content = fs.readFileSync(p, 'utf8');
        if (content.includes(PROFILE_MARKER)) return true;
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function writeEnvMarker(stage: string): boolean {
  try {
    execSync(
      'sudo mkdir -p /etc/factiii && echo "' + stage + '" | sudo tee ' + MARKER_PATH + ' > /dev/null',
      { stdio: 'inherit' }
    );
    // Also create a convenience command
    execSync(
      'echo \'#!/bin/sh\ncat ' + MARKER_PATH + '\' | sudo tee /usr/local/bin/factiii-env > /dev/null && sudo chmod +x /usr/local/bin/factiii-env',
      { stdio: 'inherit' }
    );
    return true;
  } catch {
    return false;
  }
}

function writePromptColor(stage: string): boolean {
  const color = stage === 'prod' ? '\\033[0;31m' : '\\033[0;33m'; // red : yellow
  const reset = '\\033[0m';
  const label = stage.toUpperCase();

  // Snippet that prepends [STAGING] or [PROD] to PS1
  const snippet = '\n' + PROFILE_MARKER + '\n' +
    'if [ -f ' + MARKER_PATH + ' ]; then\n' +
    '  _FACTIII_ENV=$(cat ' + MARKER_PATH + ')\n' +
    '  PS1="' + color + '[' + label + ']' + reset + ' $PS1"\n' +
    'fi\n';

  try {
    // Detect shell and write to the right rc file
    const shell = process.env.SHELL || '/bin/bash';
    const rcFile = shell.includes('zsh')
      ? process.env.HOME + '/.zshrc'
      : process.env.HOME + '/.bashrc';

    fs.appendFileSync(rcFile, snippet);
    console.log('   Added [' + label + '] prompt indicator to ' + rcFile);
    return true;
  } catch {
    return false;
  }
}

export const envMarkerFixes: Fix[] = [
  // ── Staging marker ─────────────────────────────────────────
  {
    id: 'env-marker-missing-staging',
    stage: 'staging',
    severity: 'info',
    description: 'No /etc/factiii/environment marker (hard to tell which server you\'re on)',
    scan: async (): Promise<boolean> => {
      return getCurrentMarker() !== 'staging';
    },
    fix: async (): Promise<boolean> => {
      console.log('   Writing environment marker: staging');
      return writeEnvMarker('staging');
    },
    manualFix: 'Run: sudo mkdir -p /etc/factiii && echo "staging" | sudo tee /etc/factiii/environment',
  },

  // ── Prod marker ────────────────────────────────────────────
  {
    id: 'env-marker-missing-prod',
    stage: 'prod',
    severity: 'info',
    description: 'No /etc/factiii/environment marker (hard to tell which server you\'re on)',
    scan: async (): Promise<boolean> => {
      return getCurrentMarker() !== 'prod';
    },
    fix: async (): Promise<boolean> => {
      console.log('   Writing environment marker: prod');
      return writeEnvMarker('prod');
    },
    manualFix: 'Run: sudo mkdir -p /etc/factiii && echo "prod" | sudo tee /etc/factiii/environment',
  },

  // ── Staging prompt ─────────────────────────────────────────
  {
    id: 'env-prompt-missing-staging',
    stage: 'staging',
    severity: 'info',
    description: 'Shell prompt doesn\'t show environment (easy to run prod commands on staging)',
    scan: async (): Promise<boolean> => {
      if (getCurrentMarker() !== 'staging') return false; // Marker first
      return !hasPromptMarker();
    },
    fix: async (): Promise<boolean> => {
      return writePromptColor('staging');
    },
    manualFix: 'Add to ~/.bashrc or ~/.zshrc:\n' +
      '      PS1="\\033[0;33m[STAGING]\\033[0m $PS1"',
  },

  // ── Prod prompt ────────────────────────────────────────────
  {
    id: 'env-prompt-missing-prod',
    stage: 'prod',
    severity: 'info',
    description: 'Shell prompt doesn\'t show environment (easy to run staging commands on prod)',
    scan: async (): Promise<boolean> => {
      if (getCurrentMarker() !== 'prod') return false; // Marker first
      return !hasPromptMarker();
    },
    fix: async (): Promise<boolean> => {
      return writePromptColor('prod');
    },
    manualFix: 'Add to ~/.bashrc or ~/.zshrc:\n' +
      '      PS1="\\033[0;31m[PROD]\\033[0m $PS1"',
  },
];
