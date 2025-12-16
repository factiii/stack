#!/usr/bin/env node

const { Octokit } = require('@octokit/rest');
const fs = require('fs');

async function checkSecrets() {
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
  
  // Simplified secrets - only truly sensitive values
  // HOST is in core.yml, USER defaults to ubuntu, AWS_ACCESS_KEY_ID and AWS_REGION are in core.yml
  const required = [
    'STAGING_SSH', 'PROD_SSH',           // SSH private keys
    'AWS_SECRET_ACCESS_KEY'              // Only secret AWS value
  ];
  
  // Optional secrets (env files)
  const optional = [
    'STAGING_ENVS', 'PROD_ENVS'
  ];
  
  try {
    const { data } = await octokit.rest.actions.listRepoSecrets({
      owner, repo, per_page: 100
    });
    
    const existing = data.secrets.map(s => s.name);
    const missing = required.filter(s => !existing.includes(s));
    const present = required.filter(s => existing.includes(s));
    
    console.log('🔑 GitHub Secrets Check:');
    present.forEach(s => console.log('   ✅ ' + s + ' exists'));
    missing.forEach(s => console.log('   ⚠️  ' + s + ' not found'));
    
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      'all-present=' + (missing.length === 0) + '\n' +
      'missing=' + missing.join(',') + '\n' +
      'present=' + present.join(',') + '\n'
    );
    
    if (missing.length > 0) {
      fs.writeFileSync('missing-secrets.txt', missing.join('\n'));
    }
  } catch (error) {
    console.log('❌ Failed to check secrets:', error.message);
    process.exit(1);
  }
}

checkSecrets();





