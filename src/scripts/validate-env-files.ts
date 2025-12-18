#!/usr/bin/env node

/**
 * Validates environment files match template
 */

import * as fs from 'fs';
import yaml from 'js-yaml';

interface EnvVars {
  [key: string]: string;
}

interface AutoConfig {
  isStagingSecret?: boolean;
}

interface FactiiiConfig {
  auto?: AutoConfig;
}

// Load config
const config = yaml.load(fs.readFileSync('factiii.yml', 'utf8')) as FactiiiConfig | null;
const isStagingSecret = config?.auto?.isStagingSecret !== false; // default true

// Parse env files
function parseEnvFile(filepath: string): EnvVars | null {
  if (!fs.existsSync(filepath)) return null;
  const content = fs.readFileSync(filepath, 'utf8');
  const env: EnvVars = {};
  content.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (match && match[1] && match[2] !== undefined) {
      env[match[1].trim()] = match[2].trim();
    }
  });
  return env;
}

const devEnv = parseEnvFile('.env.example');
const stagingEnv = parseEnvFile('.env.staging');
const prodEnv = parseEnvFile('.env.prod');

let hasErrors = false;

// Validate .env.example exists
if (!devEnv) {
  console.log('❌ .env.example not found (required as template)');
  hasErrors = true;
} else {
  console.log('✅ .env.example exists (' + Object.keys(devEnv).length + ' keys)');
}

// Validate .env.staging
if (!stagingEnv) {
  console.log('❌ .env.staging not found (required)');
  hasErrors = true;
} else {
  console.log('✅ .env.staging exists (' + Object.keys(stagingEnv).length + ' keys)');

  // Check keys match dev
  const devKeys = Object.keys(devEnv ?? {});
  const stagingKeys = Object.keys(stagingEnv);
  const missing = devKeys.filter((k) => !stagingKeys.includes(k));
  if (missing.length > 0) {
    console.log('⚠️  .env.staging missing keys: ' + missing.join(', '));
    hasErrors = true;
  }
}

// Validate .env.prod (optional locally)
if (!prodEnv) {
  console.log('⚠️  .env.prod not found locally (OK if in GitHub Secrets)');
} else {
  console.log('✅ .env.prod exists locally (' + Object.keys(prodEnv).length + ' keys)');

  // Check keys match dev
  const devKeys = Object.keys(devEnv ?? {});
  const prodKeys = Object.keys(prodEnv);
  const missing = devKeys.filter((k) => !prodKeys.includes(k));
  if (missing.length > 0) {
    console.log('⚠️  .env.prod missing keys: ' + missing.join(', '));
    hasErrors = true;
  }
}

if (hasErrors) {
  console.log('');
  console.log('❌ Environment file validation failed');
  process.exit(1);
}

// Write outputs
const githubOutput = process.env.GITHUB_OUTPUT;
if (githubOutput) {
  fs.appendFileSync(
    githubOutput,
    'staging-exists=' +
      (!!stagingEnv) +
      '\n' +
      'prod-exists=' +
      (!!prodEnv) +
      '\n' +
      'is-staging-secret=' +
      isStagingSecret +
      '\n'
  );
}

