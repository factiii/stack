#!/usr/bin/env node

/**
 * Gets the repo name from factiii.yml
 */

import * as fs from 'fs';
import yaml from 'js-yaml';

interface FactiiiConfig {
  name?: string;
}

try {
  const config = yaml.load(fs.readFileSync('factiii.yml', 'utf8')) as FactiiiConfig | null;
  console.log(config?.name ?? '');
} catch (e) {
  const errorMessage = e instanceof Error ? e.message : String(e);
  console.error('Error reading factiii.yml:', errorMessage);
  process.exit(1);
}

