#!/usr/bin/env node

const { Octokit } = require('@octokit/rest');
const fs = require('fs');

async function checkExisting() {
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
  
  try {
    // Check secrets
    const { data: secrets } = await octokit.rest.actions.listRepoSecrets({
      owner, repo, per_page: 100
    });
    const secretNames = secrets.secrets.map(s => s.name);
    
    // Check variables
    const { data: variables } = await octokit.rest.actions.listRepoVariables({
      owner, repo, per_page: 100
    });
    const variableNames = variables.variables.map(v => v.name);
    
    const hasStaging = secretNames.includes('STAGING_ENVS') || variableNames.includes('STAGING_ENVS');
    const hasProd = secretNames.includes('PROD_ENVS');
    
    console.log('📊 GitHub Secrets/Variables Status:');
    console.log('   STAGING_ENVS: ' + (hasStaging ? '✅ Exists' : '⚠️  Not found'));
    console.log('   PROD_ENVS: ' + (hasProd ? '✅ Exists' : '⚠️  Not found'));
    
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      'staging-exists-gh=' + hasStaging + '\n' +
      'prod-exists-gh=' + hasProd + '\n'
    );
  } catch (error) {
    console.log('❌ Failed to check existing secrets:', error.message);
    process.exit(1);
  }
}

checkExisting();





