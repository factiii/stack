#!/usr/bin/env node

const yaml = require('js-yaml');
const fs = require('fs');

try {
  const config = yaml.load(fs.readFileSync('factiii.yml', 'utf8'));
  console.log(config.name);
} catch (e) {
  console.error('Error reading factiii.yml:', e.message);
  process.exit(1);
}





