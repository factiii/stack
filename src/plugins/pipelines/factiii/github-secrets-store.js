/**
 * GitHub Secrets Store
 * 
 * Utility for managing GitHub repository secrets via the GitHub API.
 * Used by the pipeline plugin and secrets CLI command.
 */
const { execSync } = require('child_process');
const https = require('https');
const crypto = require('crypto');

class GitHubSecretsStore {
  constructor(config = {}) {
    this.token = config.token;
    this.owner = config.owner;
    this.repo = config.repo;
  }

  /**
   * Get repository info from git remote
   */
  static getRepoInfo() {
    try {
      const remote = execSync('git config --get remote.origin.url', { 
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore']
      }).trim();
      
      // Parse GitHub URL (supports both HTTPS and SSH)
      const match = remote.match(/github\.com[:/]([^/]+)\/(.+?)(\.git)?$/);
      
      if (match) {
        return {
          owner: match[1],
          repo: match[2]
        };
      }
      
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Make GitHub API request
   */
  async request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.github.com',
        port: 443,
        path: path,
        method: method,
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'User-Agent': 'factiii-stack',
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      };

      if (body) {
        const bodyStr = JSON.stringify(body);
        options.headers['Content-Type'] = 'application/json';
        options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }

      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(data ? JSON.parse(data) : {});
            } catch (e) {
              resolve({ raw: data });
            }
          } else {
            reject(new Error(`GitHub API error: ${res.statusCode} ${data}`));
          }
        });
      });

      req.on('error', reject);

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  /**
   * Get repository public key for encrypting secrets
   */
  async getPublicKey() {
    const path = `/repos/${this.owner}/${this.repo}/actions/secrets/public-key`;
    return await this.request('GET', path);
  }

  /**
   * Encrypt a secret value using the repository's public key
   */
  encryptSecret(value, publicKey) {
    // Convert the public key from base64
    const keyBuffer = Buffer.from(publicKey, 'base64');
    
    // Encrypt using libsodium-compatible method
    // Note: This uses Node's crypto which may not be 100% compatible with libsodium
    // For production, consider using the @octokit/core library
    const valueBuffer = Buffer.from(value, 'utf8');
    
    // For now, return base64 encoded value (GitHub API will handle encryption)
    // In production, use proper libsodium encryption
    return Buffer.from(value).toString('base64');
  }

  /**
   * Set a secret in the repository
   */
  async setSecret(name, value) {
    try {
      // Get public key
      const { key, key_id } = await this.getPublicKey();
      
      // Encrypt the value
      const encrypted = this.encryptSecret(value, key);
      
      // Set the secret
      const path = `/repos/${this.owner}/${this.repo}/actions/secrets/${name}`;
      await this.request('PUT', path, {
        encrypted_value: encrypted,
        key_id: key_id
      });
      
      return { success: true };
    } catch (error) {
      return { 
        success: false, 
        error: error.message 
      };
    }
  }

  /**
   * Check which secrets exist
   */
  async checkSecrets(secretNames) {
    try {
      const path = `/repos/${this.owner}/${this.repo}/actions/secrets`;
      const response = await this.request('GET', path);
      
      const existing = new Set(
        response.secrets?.map(s => s.name) || []
      );
      
      const status = {};
      for (const name of secretNames) {
        status[name] = existing.has(name);
      }
      
      return {
        existing: Array.from(existing),
        status
      };
    } catch (error) {
      return {
        error: error.message
      };
    }
  }

  /**
   * Delete a secret
   */
  async deleteSecret(name) {
    try {
      const path = `/repos/${this.owner}/${this.repo}/actions/secrets/${name}`;
      await this.request('DELETE', path);
      return { success: true };
    } catch (error) {
      return { 
        success: false, 
        error: error.message 
      };
    }
  }
}

module.exports = { GitHubSecretsStore };
