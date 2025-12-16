#!/usr/bin/env node

const yaml = require('js-yaml');
const fs = require('fs');

try {
  if (!fs.existsSync('core.yml')) {
    console.log('❌ core.yml not found');
    process.exit(1);
  }
  
  console.log('✅ core.yml exists');
  
  const config = yaml.load(fs.readFileSync('core.yml', 'utf8'));
  if (!config.name) {
    console.log('❌ core.yml missing required field: name');
    process.exit(1);
  }
  if (!config.environments) {
    console.log('❌ core.yml missing required field: environments');
    process.exit(1);
  }
  console.log('✅ core.yml is valid');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, 'repo-name=' + config.name + '\n');
} catch (e) {
  console.log('❌ core.yml has syntax errors:', e.message);
  process.exit(1);
}





