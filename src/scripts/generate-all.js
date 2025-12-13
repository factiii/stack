#!/usr/bin/env node

/**
 * Standalone script to generate docker-compose.yml and nginx.conf
 * from multiple config files in a directory
 * 
 * Usage: node generate-all.js [configs-dir] [output-dir]
 */

const path = require('path');
const generateCompose = require('../generators/generate-compose');
const generateNginx = require('../generators/generate-nginx');

const configsDir = process.argv[2] || path.join(__dirname, '../../configs');
const outputDir = process.argv[3] || path.join(__dirname, '../../');

const composeFile = path.join(outputDir, 'docker-compose.yml');
const nginxFile = path.join(outputDir, 'nginx/nginx.conf');

console.log('🔧 Generating infrastructure files...\n');
console.log(`   Configs directory: ${configsDir}`);
console.log(`   Output directory: ${outputDir}\n`);

try {
  generateCompose(configsDir, composeFile);
  generateNginx(configsDir, nginxFile);
  
  console.log('\n✅ All files generated successfully!');
} catch (error) {
  console.error(`\n❌ Error: ${error.message}`);
  process.exit(1);
}


