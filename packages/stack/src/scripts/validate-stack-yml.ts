#!/usr/bin/env node

/**
 * Validates stack.yml (or factiii.yml) configuration file
 */

import * as fs from 'fs';
import yaml from 'js-yaml';
import { getStackConfigPath } from '../constants/config-files.js';

interface FactiiiConfig {
  name?: string;
  environments?: Record<string, unknown>;
}

try {
  const configPath = getStackConfigPath(process.cwd());
  if (!fs.existsSync(configPath)) {
    console.log('[ERROR] stack.yml or factiii.yml not found');
    process.exit(1);
  }

  console.log('[OK] Config file exists');

  const config = yaml.load(fs.readFileSync(configPath, 'utf8')) as FactiiiConfig | null;
  if (!config?.name) {
    console.log('[ERROR] Config missing required field: name');
    process.exit(1);
  }
  const hasEnvironments = config?.environments && Object.keys(config.environments).length > 0;
  const hasTopLevelEnv = !!(config && ('staging' in config || 'prod' in config));
  if (!hasEnvironments && !hasTopLevelEnv) {
    console.log('[ERROR] Config must have environments or top-level staging/prod');
    process.exit(1);
  }
  console.log('[OK] Config is valid');

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    fs.appendFileSync(githubOutput, 'repo-name=' + config.name + '\n');
  }
} catch (e) {
  const errorMessage = e instanceof Error ? e.message : String(e);
  console.log('[ERROR] Config has syntax errors:', errorMessage);
  process.exit(1);
}
