#!/usr/bin/env node

/**
 * Gets the repo name from stack.yml (or factiii.yml)
 */

import * as fs from 'fs';
import yaml from 'js-yaml';
import { getStackConfigPath } from '../constants/config-files.js';

interface FactiiiConfig {
  name?: string;
}

try {
  const configPath = getStackConfigPath(process.cwd());
  const config = yaml.load(fs.readFileSync(configPath, 'utf8')) as FactiiiConfig | null;
  console.log(config?.name ?? '');
} catch (e) {
  const errorMessage = e instanceof Error ? e.message : String(e);
  console.error('Error reading config: ' + errorMessage);
  process.exit(1);
}

