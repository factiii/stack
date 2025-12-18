#!/usr/bin/env node

/**
 * Checks for existing GitHub secrets
 */

import * as fs from 'fs';
import { Octokit } from '@octokit/rest';

interface Secret {
  name: string;
}

interface Variable {
  name: string;
}

async function checkExisting(): Promise<void> {
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const githubRepository = process.env.GITHUB_REPOSITORY;

  if (!githubRepository) {
    console.log('❌ GITHUB_REPOSITORY not set');
    process.exit(1);
  }

  const [owner, repo] = githubRepository.split('/');

  if (!owner || !repo) {
    console.log('❌ Invalid GITHUB_REPOSITORY format');
    process.exit(1);
  }

  try {
    // Check secrets
    const { data: secrets } = await octokit.rest.actions.listRepoSecrets({
      owner,
      repo,
      per_page: 100,
    });
    const secretNames = (secrets.secrets as Secret[]).map((s) => s.name);

    // Check variables
    const { data: variables } = await octokit.rest.actions.listRepoVariables({
      owner,
      repo,
      per_page: 100,
    });
    const variableNames = (variables.variables as Variable[]).map((v) => v.name);

    const hasStaging =
      secretNames.includes('STAGING_ENVS') || variableNames.includes('STAGING_ENVS');
    const hasProd = secretNames.includes('PROD_ENVS');

    console.log('📊 GitHub Secrets/Variables Status:');
    console.log('   STAGING_ENVS: ' + (hasStaging ? '✅ Exists' : '⚠️  Not found'));
    console.log('   PROD_ENVS: ' + (hasProd ? '✅ Exists' : '⚠️  Not found'));

    const githubOutput = process.env.GITHUB_OUTPUT;
    if (githubOutput) {
      fs.appendFileSync(
        githubOutput,
        'staging-exists-gh=' + hasStaging + '\n' + 'prod-exists-gh=' + hasProd + '\n'
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.log('❌ Failed to check existing secrets:', errorMessage);
    process.exit(1);
  }
}

checkExisting();

