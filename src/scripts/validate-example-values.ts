#!/usr/bin/env node

/**
 * Validates that stack.yml doesn't contain EXAMPLE_ placeholder values
 * This script properly parses YAML and ignores comments
 * Use this in workflows instead of grep to avoid false positives from documentation
 */

import * as fs from 'fs';
import yaml from 'js-yaml';
import { getStackConfigPath } from '../constants/config-files.js';

interface ExampleValue {
  path: string;
  value: string;
}

const configPath = process.argv[2] ?? getStackConfigPath(process.cwd());

if (!fs.existsSync(configPath)) {
  console.log(`❌ ${configPath} not found`);
  process.exit(1);
}

try {
  const content = fs.readFileSync(configPath, 'utf8');
  const config = yaml.load(content);

  const exampleValues: ExampleValue[] = [];

  // Recursively scan parsed YAML object for EXAMPLE_ values
  // This properly ignores comments since we're scanning the parsed structure
  function scanForExamples(obj: unknown, path: string = ''): void {
    if (typeof obj === 'string' && obj.includes('EXAMPLE_')) {
      exampleValues.push({ path: path || 'root', value: obj });
    } else if (typeof obj === 'object' && obj !== null) {
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        const newPath = path ? `${path}.${key}` : key;
        scanForExamples(value, newPath);
      }
    }
  }

  scanForExamples(config);

  if (exampleValues.length > 0) {
    console.log('❌ Found EXAMPLE_ placeholder values in ' + configPath);
    console.log('');
    exampleValues.forEach(({ path, value }) => {
      console.log(`   ${path}: ${value}`);
    });
    console.log('');
    console.log('💡 Please replace all EXAMPLE_ values with your actual configuration.');
    process.exit(1);
  }

  console.log('✅ No EXAMPLE_ placeholder values found');
  process.exit(0);
} catch (error) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.log('❌ Failed to parse ' + configPath + ':', errorMessage);
  process.exit(1);
}

