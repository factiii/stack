#!/usr/bin/env node

/**
 * Validates factiii.yml configuration file
 */

import * as fs from 'fs';
import yaml from 'js-yaml';

interface FactiiiConfig {
  name?: string;
  environments?: Record<string, unknown>;
}

try {
  if (!fs.existsSync('factiii.yml')) {
    console.log('❌ factiii.yml not found');
    process.exit(1);
  }

  console.log('✅ factiii.yml exists');

  const config = yaml.load(fs.readFileSync('factiii.yml', 'utf8')) as FactiiiConfig | null;
  if (!config?.name) {
    console.log('❌ factiii.yml missing required field: name');
    process.exit(1);
  }
  if (!config?.environments) {
    console.log('❌ factiii.yml missing required field: environments');
    process.exit(1);
  }
  console.log('✅ factiii.yml is valid');

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    fs.appendFileSync(githubOutput, 'repo-name=' + config.name + '\n');
  }
} catch (e) {
  const errorMessage = e instanceof Error ? e.message : String(e);
  console.log('❌ factiii.yml has syntax errors:', errorMessage);
  process.exit(1);
}

