/**
 * Secrets Command
 *
 * Manages GitHub secrets
 */

import { GitHubSecretsStore } from '../plugins/pipelines/factiii/github-secrets-store.js';
import { promptForSecret } from '../utils/secret-prompts.js';
import type { SecretsOptions } from '../types/index.js';

export async function secrets(
  action: 'list' | 'set' | 'check',
  secretName?: string,
  options: SecretsOptions = {}
): Promise<void> {
  const store = new GitHubSecretsStore({
    token: options.token ?? process.env.GITHUB_TOKEN,
  });

  switch (action) {
    case 'list': {
      console.log('📋 Checking GitHub secrets...\n');
      const required = ['STAGING_SSH', 'PROD_SSH', 'AWS_SECRET_ACCESS_KEY'];
      const result = await store.checkSecrets(required);

      if (result.error) {
        console.log(`❌ Error: ${result.error}`);
        return;
      }

      for (const name of required) {
        const exists = result.status?.[name] ?? false;
        const icon = exists ? '✅' : '⚠️';
        const status = exists ? 'exists' : 'missing';
        console.log(`   ${icon} ${name}: ${status}`);
      }
      break;
    }

    case 'set': {
      if (!secretName) {
        console.log('❌ Secret name required');
        return;
      }

      let value = options.value;
      if (!value) {
        value = await promptForSecret(secretName);
      }

      console.log(`\n📝 Setting ${secretName}...`);
      const result = await store.setSecret(secretName, value);

      if (result.success) {
        console.log(`✅ ${secretName} set successfully`);
      } else {
        console.log(`❌ Failed to set ${secretName}: ${result.error}`);
      }
      break;
    }

    case 'check': {
      const secretNames = secretName ? [secretName] : ['STAGING_SSH', 'PROD_SSH', 'AWS_SECRET_ACCESS_KEY'];
      const result = await store.checkSecrets(secretNames);

      if (result.error) {
        console.log(`❌ Error: ${result.error}`);
        return;
      }

      for (const name of secretNames) {
        const exists = result.status?.[name] ?? false;
        console.log(`${exists ? '✅' : '❌'} ${name}`);
      }
      break;
    }
  }
}

export default secrets;

