#!/usr/bin/env node
/**
 * ============================================================================
 * LEGACY SCRIPT - For backward compatibility with centralized approach
 * ============================================================================
 * This script is part of the legacy centralized infrastructure-config.yml
 * approach. For new repositories, use the decentralized approach with
 * the npm package CLI commands (npx core generate-workflows, etc.)
 * ============================================================================
 * 
 * Generates .github/workflows/setup-infrastructure.yml from template
 * 
 * Reads infrastructure-config.yml and generates the workflow file with
 * all required secrets statically mapped in the env: block.
 * 
 * Usage: node scripts/generate-workflow.js
 * 
 * No dependencies required - uses simple YAML parsing for our config format.
 */

const fs = require('fs');
const path = require('path');

// Paths
const ROOT_DIR = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'infrastructure-config.yml');
const TEMPLATE_PATH = path.join(ROOT_DIR, '.github/workflows/setup-infrastructure.yml.template');
const OUTPUT_PATH = path.join(ROOT_DIR, '.github/workflows/setup-infrastructure.yml');

// Simple YAML parser for our specific config format
function parseSimpleYaml(content) {
  const config = { servers: {} };
  const lines = content.split('\n');
  
  let currentServer = null;
  let currentRepo = null;
  let inRepos = false;
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    // Detect indentation level
    const indent = line.search(/\S/);
    
    // Top-level keys
    if (indent === 0) {
      if (trimmed === 'servers:') {
        // servers block starts
      } else if (trimmed.startsWith('base_domain:')) {
        config.base_domain = trimmed.split(':').slice(1).join(':').trim();
      } else if (trimmed.startsWith('ssl_email:')) {
        config.ssl_email = trimmed.split(':').slice(1).join(':').trim();
      }
      continue;
    }
    
    // Server names (indent 2)
    if (indent === 2 && trimmed.endsWith(':') && !trimmed.includes(' ')) {
      currentServer = trimmed.slice(0, -1);
      config.servers[currentServer] = { repos: [] };
      inRepos = false;
      continue;
    }
    
    // Server properties (indent 4)
    if (indent === 4 && currentServer) {
      if (trimmed.startsWith('ssh_key_secret:')) {
        config.servers[currentServer].ssh_key_secret = trimmed.split(':').slice(1).join(':').trim();
      } else if (trimmed.startsWith('host:')) {
        config.servers[currentServer].host = trimmed.split(':').slice(1).join(':').trim();
      } else if (trimmed.startsWith('user:')) {
        config.servers[currentServer].user = trimmed.split(':').slice(1).join(':').trim();
      } else if (trimmed === 'repos:') {
        inRepos = true;
      }
      continue;
    }
    
    // Repo list items (indent 6, starts with -)
    if (indent === 6 && inRepos && trimmed.startsWith('- name:')) {
      currentRepo = { name: trimmed.replace('- name:', '').trim() };
      config.servers[currentServer].repos.push(currentRepo);
      continue;
    }
    
    // Repo properties (indent 8)
    if (indent === 8 && currentRepo) {
      if (trimmed.startsWith('environment:')) {
        currentRepo.environment = trimmed.split(':').slice(1).join(':').trim();
      } else if (trimmed.startsWith('domain_override:')) {
        const value = trimmed.split(':').slice(1).join(':').trim();
        currentRepo.domain_override = value === 'null' ? null : value;
      }
    }
  }
  
  return config;
}

// Extract all required secrets from config
function extractSecrets(config) {
  const sshSecrets = new Set();
  const envSecrets = new Set();

  for (const [serverName, serverConfig] of Object.entries(config.servers || {})) {
    // SSH key secret
    if (serverConfig.ssh_key_secret) {
      sshSecrets.add(serverConfig.ssh_key_secret);
    }

    // Env secrets for each repo
    for (const repo of serverConfig.repos || []) {
      const repoName = repo.name.toUpperCase().replace(/-/g, '_');
      const env = repo.environment.toUpperCase();
      envSecrets.add(`${repoName}_${env}_ENVS`);
    }
  }

  return {
    ssh: Array.from(sshSecrets).sort(),
    env: Array.from(envSecrets).sort()
  };
}

// Generate the env: block content
function generateEnvBlock(secrets) {
  const lines = [];
  
  lines.push('          # Auto-generated from infrastructure-config.yml');
  lines.push('          # Re-run: node scripts/generate-workflow.js');
  lines.push('          #');
  lines.push('          # SSH Keys (one per server)');
  
  for (const secret of secrets.ssh) {
    lines.push(`          ${secret}: \${{ secrets.${secret} }}`);
  }
  
  lines.push('          #');
  lines.push('          # Environment Variables (one per repo/environment)');
  
  for (const secret of secrets.env) {
    lines.push(`          ${secret}: \${{ secrets.${secret} }}`);
  }

  return lines.join('\n');
}

// Main
function main() {
  console.log('📝 Generating workflow from template...\n');

  // Load config
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`❌ Config not found: ${CONFIG_PATH}`);
    process.exit(1);
  }
  const configContent = fs.readFileSync(CONFIG_PATH, 'utf8');
  const config = parseSimpleYaml(configContent);
  console.log('✅ Loaded infrastructure-config.yml');

  // Extract secrets
  const secrets = extractSecrets(config);
  console.log(`   Found ${secrets.ssh.length} SSH secrets: ${secrets.ssh.join(', ')}`);
  console.log(`   Found ${secrets.env.length} env secrets: ${secrets.env.join(', ')}`);

  // Load template
  if (!fs.existsSync(TEMPLATE_PATH)) {
    console.error(`❌ Template not found: ${TEMPLATE_PATH}`);
    process.exit(1);
  }

  let template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  console.log('✅ Loaded template');

  // Generate env block
  const envBlock = generateEnvBlock(secrets);

  // Replace placeholder
  const output = template.replace('{{SECRETS_ENV_BLOCK}}', envBlock);

  // Write output
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, output);
  console.log(`\n✅ Generated: ${OUTPUT_PATH}`);

  // Summary
  console.log('\n📋 Required GitHub Secrets:');
  console.log('   SSH Keys:');
  for (const s of secrets.ssh) {
    console.log(`     - ${s}`);
  }
  console.log('   Environment Variables:');
  for (const s of secrets.env) {
    console.log(`     - ${s}`);
  }
}

main();
