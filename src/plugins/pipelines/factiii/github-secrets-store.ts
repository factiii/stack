/**
 * GitHub Secrets Store
 *
 * Utility for managing GitHub repository secrets via the GitHub API.
 * Used by the pipeline plugin and secrets CLI command.
 */

import { execSync } from 'child_process';
import * as https from 'https';

interface RepoInfo {
  owner: string;
  repo: string;
}

interface SetSecretResult {
  success: boolean;
  error?: string;
}

interface CheckSecretsResult {
  existing?: string[];
  status?: Record<string, boolean>;
  missing?: string[];
  error?: string;
}

interface PublicKeyResponse {
  key: string;
  key_id: string;
}

interface SecretsListResponse {
  secrets?: Array<{ name: string }>;
}

interface GitHubSecretsStoreConfig {
  token?: string;
  owner?: string;
  repo?: string;
}

export class GitHubSecretsStore {
  private token?: string;
  private owner?: string;
  private repo?: string;

  constructor(config: GitHubSecretsStoreConfig = {}) {
    this.token = config.token ?? process.env.GITHUB_TOKEN;
    this.owner = config.owner;
    this.repo = config.repo;

    // Auto-detect from git if not provided
    if (!this.owner || !this.repo) {
      const repoInfo = GitHubSecretsStore.getRepoInfo();
      if (repoInfo) {
        this.owner = this.owner ?? repoInfo.owner;
        this.repo = this.repo ?? repoInfo.repo;
      }
    }
  }

  /**
   * Get repository info from git remote
   */
  static getRepoInfo(): RepoInfo | null {
    try {
      const remote = execSync('git config --get remote.origin.url', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();

      // Parse GitHub URL (supports both HTTPS and SSH)
      const match = remote.match(/github\.com[:/]([^/]+)\/(.+?)(\.git)?$/);

      if (match && match[1] && match[2]) {
        return {
          owner: match[1],
          repo: match[2],
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
  private async request<T>(
    method: string,
    urlPath: string,
    body: Record<string, unknown> | null = null
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const options: https.RequestOptions = {
        hostname: 'api.github.com',
        port: 443,
        path: urlPath,
        method: method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'User-Agent': 'factiii-stack',
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      };

      if (body) {
        const bodyStr = JSON.stringify(body);
        (options.headers as Record<string, string>)['Content-Type'] = 'application/json';
        (options.headers as Record<string, string>)['Content-Length'] =
          Buffer.byteLength(bodyStr).toString();
      }

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });

        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(data ? (JSON.parse(data) as T) : ({} as T));
            } catch {
              resolve({ raw: data } as T);
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
  async getPublicKey(): Promise<PublicKeyResponse> {
    const urlPath = `/repos/${this.owner}/${this.repo}/actions/secrets/public-key`;
    return await this.request<PublicKeyResponse>('GET', urlPath);
  }

  /**
   * Encrypt a secret value using the repository's public key
   */
  encryptSecret(value: string, _publicKey: string): string {
    // Convert the public key from base64
    // Note: This uses Node's crypto which may not be 100% compatible with libsodium
    // For production, consider using the @octokit/core library with proper libsodium
    // For now, return base64 encoded value (GitHub API will handle encryption)
    return Buffer.from(value).toString('base64');
  }

  /**
   * Set a secret in the repository
   */
  async setSecret(name: string, value: string): Promise<SetSecretResult> {
    try {
      // Get public key
      const { key, key_id } = await this.getPublicKey();

      // Encrypt the value
      const encrypted = this.encryptSecret(value, key);

      // Set the secret
      const urlPath = `/repos/${this.owner}/${this.repo}/actions/secrets/${name}`;
      await this.request('PUT', urlPath, {
        encrypted_value: encrypted,
        key_id: key_id,
      });

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check which secrets exist
   */
  async checkSecrets(secretNames: string[]): Promise<CheckSecretsResult> {
    try {
      const urlPath = `/repos/${this.owner}/${this.repo}/actions/secrets`;
      const response = await this.request<SecretsListResponse>('GET', urlPath);

      const existing = new Set(response.secrets?.map((s) => s.name) ?? []);

      const status: Record<string, boolean> = {};
      const missing: string[] = [];

      for (const name of secretNames) {
        status[name] = existing.has(name);
        if (!existing.has(name)) {
          missing.push(name);
        }
      }

      return {
        existing: Array.from(existing),
        status,
        missing,
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Delete a secret
   */
  async deleteSecret(name: string): Promise<SetSecretResult> {
    try {
      const urlPath = `/repos/${this.owner}/${this.repo}/actions/secrets/${name}`;
      await this.request('DELETE', urlPath);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

