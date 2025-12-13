const { Octokit } = require('@octokit/rest');
const sodium = require('libsodium-wrappers');

/**
 * Get required GitHub secrets list based on core.yml configuration
 */
function getRequiredSecrets(config) {
  const required = [
    // SSH and server configuration
    'STAGING_SSH',
    'STAGING_HOST',
    'STAGING_USER',
    'PROD_SSH',
    'PROD_HOST',
    'PROD_USER',
    
    // AWS credentials for ECR
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_REGION',
    
    // Environment variables (shared across all repos)
    'STAGING_ENVS',
    'PROD_ENVS'
  ];
  
  return required;
}

/**
 * Check which GitHub secrets exist using GitHub API
 * @param {string} owner - GitHub repository owner
 * @param {string} repo - GitHub repository name
 * @param {string} token - GitHub token with repo scope
 * @param {object} config - Parsed core.yml configuration
 * @returns {Promise<object>} - Object with present, missing, and error arrays
 */
async function checkGitHubSecrets(owner, repo, token, config) {
  const result = {
    present: [],
    missing: [],
    error: null
  };
  
  if (!token) {
    result.error = 'No GitHub token provided';
    return result;
  }
  
  const octokit = new Octokit({ auth: token });
  const requiredSecrets = getRequiredSecrets(config);
  
  try {
    // Get list of all secrets in the repository
    const { data } = await octokit.rest.actions.listRepoSecrets({
      owner,
      repo,
      per_page: 100
    });
    
    const existingSecretNames = data.secrets.map(s => s.name);
    
    // Check each required secret
    for (const secretName of requiredSecrets) {
      if (existingSecretNames.includes(secretName)) {
        result.present.push(secretName);
      } else {
        result.missing.push(secretName);
      }
    }
    
  } catch (error) {
    if (error.status === 401) {
      result.error = 'GitHub token is invalid or expired';
    } else if (error.status === 403) {
      result.error = 'GitHub token does not have permission to access secrets';
    } else if (error.status === 404) {
      result.error = 'Repository not found or token lacks access';
    } else {
      result.error = `Failed to check secrets: ${error.message}`;
    }
  }
  
  return result;
}

/**
 * Format secrets check result for display
 */
function formatSecretsReport(secretsCheck) {
  const lines = [];
  
  if (secretsCheck.error) {
    lines.push(`❌ ${secretsCheck.error}`);
    lines.push('   Cannot verify secrets via API');
    return lines.join('\n');
  }
  
  if (secretsCheck.present.length > 0) {
    for (const secret of secretsCheck.present) {
      lines.push(`   ✅ ${secret} exists`);
    }
  }
  
  if (secretsCheck.missing.length > 0) {
    for (const secret of secretsCheck.missing) {
      lines.push(`   ⚠️  ${secret} not found`);
    }
  }
  
  return lines.join('\n');
}

/**
 * Get GitHub repository info from git remote
 */
function getGitHubRepoInfo() {
  const { execSync } = require('child_process');
  
  try {
    const repoUrl = execSync('git config --get remote.origin.url', { 
      encoding: 'utf8',
      stdio: 'pipe'
    }).trim();
    
    const match = repoUrl.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/);
    if (match) {
      return {
        owner: match[1],
        repo: match[2]
      };
    }
  } catch (e) {
    // Ignore errors
  }
  
  return null;
}

/**
 * Encrypt a secret value for GitHub using libsodium
 * @param {string} value - Secret value to encrypt
 * @param {string} publicKey - Repository public key (base64)
 * @param {string} keyId - Repository public key ID
 * @returns {Promise<string>} - Encrypted secret (base64)
 */
async function encryptSecret(value, publicKey, keyId) {
  await sodium.ready;
  
  // Decode the public key
  const publicKeyBytes = Buffer.from(publicKey, 'base64');
  
  // Encrypt the secret
  const messageBytes = Buffer.from(value, 'utf8');
  const encryptedBytes = sodium.crypto_box_seal(messageBytes, publicKeyBytes);
  
  return Buffer.from(encryptedBytes).toString('base64');
}

/**
 * Upload a secret to GitHub repository
 * @param {string} owner - GitHub repository owner
 * @param {string} repo - GitHub repository name
 * @param {string} secretName - Name of the secret
 * @param {string} secretValue - Value of the secret
 * @param {string} token - GitHub token with repo scope
 * @returns {Promise<object>} - Result with success status and error if any
 */
async function uploadSecret(owner, repo, secretName, secretValue, token) {
  const result = {
    success: false,
    error: null
  };
  
  if (!token) {
    result.error = 'No GitHub token provided';
    return result;
  }
  
  const octokit = new Octokit({ auth: token });
  
  try {
    // Get repository public key
    const { data: publicKeyData } = await octokit.rest.actions.getRepoPublicKey({
      owner,
      repo
    });
    
    // Encrypt the secret
    const encryptedValue = await encryptSecret(
      secretValue,
      publicKeyData.key,
      publicKeyData.key_id
    );
    
    // Upload the secret
    await octokit.rest.actions.createOrUpdateRepoSecret({
      owner,
      repo,
      secret_name: secretName,
      encrypted_value: encryptedValue,
      key_id: publicKeyData.key_id
    });
    
    result.success = true;
  } catch (error) {
    if (error.status === 401) {
      result.error = 'GitHub token is invalid or expired';
    } else if (error.status === 403) {
      result.error = 'GitHub token does not have permission to create/update secrets';
    } else if (error.status === 404) {
      result.error = 'Repository not found or token lacks access';
    } else {
      result.error = `Failed to upload secret: ${error.message}`;
    }
  }
  
  return result;
}

module.exports = {
  getRequiredSecrets,
  checkGitHubSecrets,
  formatSecretsReport,
  getGitHubRepoInfo,
  uploadSecret
};

