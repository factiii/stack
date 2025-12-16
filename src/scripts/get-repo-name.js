#!/usr/bin/env node

const yaml = require('js-yaml');
const fs = require('fs');

try {
  const config = yaml.load(fs.readFileSync('core.yml', 'utf8'));
  console.log(config.name);
} catch (e) {
  console.error('Error reading core.yml:', e.message);
  process.exit(1);
}





