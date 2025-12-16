#!/usr/bin/env node

const yaml = require('js-yaml');
const fs = require('fs');

try {
  if (!fs.existsSync('factiii.yml')) {
    console.log('❌ factiii.yml not found');
    process.exit(1);
  }
  
  console.log('✅ factiii.yml exists');
  
  const config = yaml.load(fs.readFileSync('factiii.yml', 'utf8'));
  if (!config.name) {
    console.log('❌ factiii.yml missing required field: name');
    process.exit(1);
  }
  if (!config.environments) {
    console.log('❌ factiii.yml missing required field: environments');
    process.exit(1);
  }
  console.log('✅ factiii.yml is valid');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, 'repo-name=' + config.name + '\n');
} catch (e) {
  console.log('❌ factiii.yml has syntax errors:', e.message);
  process.exit(1);
}





