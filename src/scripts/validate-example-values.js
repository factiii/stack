#!/usr/bin/env node

/**
 * Validates that core.yml doesn't contain EXAMPLE- placeholder values
 * This script properly parses YAML and ignores comments
 * Use this in workflows instead of grep to avoid false positives from documentation
 */

const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');

const configPath = process.argv[2] || 'core.yml';

if (!fs.existsSync(configPath)) {
  console.log(`❌ ${configPath} not found`);
  process.exit(1);
}

try {
  const content = fs.readFileSync(configPath, 'utf8');
  const config = yaml.load(content);
  
  const exampleValues = [];
  
  // Recursively scan parsed YAML object for EXAMPLE- values
  // This properly ignores comments since we're scanning the parsed structure
  function scanForExamples(obj, path = '') {
    if (typeof obj === 'string' && obj.includes('EXAMPLE-')) {
      exampleValues.push({ path: path || 'root', value: obj });
    } else if (typeof obj === 'object' && obj !== null) {
      for (const [key, value] of Object.entries(obj)) {
        const newPath = path ? `${path}.${key}` : key;
        scanForExamples(value, newPath);
      }
    }
  }
  
  scanForExamples(config);
  
  if (exampleValues.length > 0) {
    console.log('❌ Found EXAMPLE- placeholder values in ' + configPath);
    console.log('');
    exampleValues.forEach(({ path, value }) => {
      console.log(`   ${path}: ${value}`);
    });
    console.log('');
    console.log('💡 Please replace all EXAMPLE- values with your actual configuration.');
    process.exit(1);
  }
  
  console.log('✅ No EXAMPLE- placeholder values found');
  process.exit(0);
  
} catch (error) {
  console.log('❌ Failed to parse ' + configPath + ':', error.message);
  process.exit(1);
}

