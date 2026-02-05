/**
 * Ansible Vault Secrets
 *
 * Read, write, and check secrets stored in an Ansible Vault–encrypted YAML file.
 * Used by the secrets CLI and pipeline secrets stage. Requires ansible-vault on PATH.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import yaml from 'js-yaml';

export interface AnsibleVaultSecretsConfig {
  /** Path to the vault file (relative to rootDir or absolute) */
  vault_path: string;
  /** Optional path to file containing vault password */
  vault_password_file?: string;
  /** Root directory for resolving relative vault_path */
  rootDir?: string;
}

export interface SetSecretResult {
  success: boolean;
  error?: string;
}

export interface CheckSecretsResult {
  status?: Record<string, boolean>;
  missing?: string[];
  error?: string;
}

function getVaultPasswordFile(config: AnsibleVaultSecretsConfig): string | undefined {
  if (config.vault_password_file) {
    const expanded = config.vault_password_file.replace(/^~/, os.homedir());
    if (fs.existsSync(expanded)) return expanded;
  }
  const envFile = process.env.ANSIBLE_VAULT_PASSWORD_FILE;
  if (envFile) {
    const expanded = envFile.replace(/^~/, os.homedir());
    if (fs.existsSync(expanded)) return expanded;
  }
  return undefined;
}

function getVaultPassword(): string | undefined {
  return process.env.ANSIBLE_VAULT_PASSWORD ?? undefined;
}

/**
 * Resolve vault file path (absolute)
 */
function resolveVaultPath(config: AnsibleVaultSecretsConfig): string {
  const p = config.vault_path.replace(/^~/, os.homedir());
  if (path.isAbsolute(p)) return p;
  const root = config.rootDir ?? process.cwd();
  return path.join(root, p);
}

/**
 * Get path to vault password (file or temp file with env password)
 */
function getVaultPasswordFileForExec(config: AnsibleVaultSecretsConfig): string {
  const file = getVaultPasswordFile(config);
  if (file) return file;
  const pass = getVaultPassword();
  if (pass) {
    const tmp = path.join(os.tmpdir(), `factiii-vault-pass-${Date.now()}`);
    fs.writeFileSync(tmp, pass, 'utf8');
    return tmp;
  }
  throw new Error(
    'Vault password required. Set ansible.vault_password_file in factiii.yml, or ANSIBLE_VAULT_PASSWORD_FILE / ANSIBLE_VAULT_PASSWORD env.'
  );
}

/**
 * Run ansible-vault view to get decrypted content
 */
function vaultView(vaultPath: string, config: AnsibleVaultSecretsConfig): string {
  const passFile = getVaultPasswordFileForExec(config);
  const isTempFile = passFile.startsWith(os.tmpdir());
  
  try {
    // Escape path for shell (handle spaces and special chars)
    const escapedVaultPath = vaultPath.replace(/"/g, '\\"');
    const escapedPassFile = passFile.replace(/"/g, '\\"');
    
    const result = execSync(
      `ansible-vault view "${escapedVaultPath}" --vault-password-file "${escapedPassFile}"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    
    // Cleanup temp password file if we created it
    if (isTempFile && fs.existsSync(passFile)) {
      try {
        fs.unlinkSync(passFile);
      } catch {
        // ignore cleanup errors
      }
    }
    return result;
  } catch (e) {
    // Cleanup temp password file on error
    if (isTempFile && fs.existsSync(passFile)) {
      try {
        fs.unlinkSync(passFile);
      } catch {
        // ignore cleanup errors
      }
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Ansible Vault view failed: ${msg}`);
  }
}

/**
 * Run ansible-vault encrypt to encrypt a file to output path
 */
function vaultEncrypt(
  inputPath: string,
  outputPath: string,
  config: AnsibleVaultSecretsConfig
): void {
  const passFile = getVaultPasswordFileForExec(config);
  const isTempFile = passFile.startsWith(os.tmpdir());
  
  try {
    // Escape paths for shell (handle spaces and special chars)
    const escapedInputPath = inputPath.replace(/"/g, '\\"');
    const escapedOutputPath = outputPath.replace(/"/g, '\\"');
    const escapedPassFile = passFile.replace(/"/g, '\\"');
    
    execSync(
      `ansible-vault encrypt "${escapedInputPath}" --output="${escapedOutputPath}" --vault-password-file "${escapedPassFile}"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Ansible Vault encrypt failed: ${msg}`);
  } finally {
    // Cleanup temp password file if we created it
    if (isTempFile && fs.existsSync(passFile)) {
      try {
        fs.unlinkSync(passFile);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

/**
 * Parse decrypted vault content as YAML (flat key-value)
 */
function parseVaultContent(content: string): Record<string, string> {
  const parsed = yaml.load(content);
  if (parsed == null) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string') out[k] = v;
    else if (v != null) out[k] = String(v);
  }
  return out;
}

/**
 * Ansible Vault–backed secret operations.
 * Uses ansible-vault view/encrypt; vault password from config or ANSIBLE_VAULT_PASSWORD_FILE / ANSIBLE_VAULT_PASSWORD.
 */
export class AnsibleVaultSecrets {
  private config: AnsibleVaultSecretsConfig;

  constructor(config: AnsibleVaultSecretsConfig) {
    this.config = {
      rootDir: config.rootDir ?? process.cwd(),
      ...config,
    };
  }

  /**
   * Ensure vault file exists; if not, create an empty encrypted file
   */
  private ensureVaultExists(vaultPath: string): void {
    if (fs.existsSync(vaultPath)) return;
    const dir = path.dirname(vaultPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(os.tmpdir(), `factiii-vault-${Date.now()}.yml`);
    fs.writeFileSync(tmp, '# Factiii secrets\n{}\n', 'utf8');
    vaultEncrypt(tmp, vaultPath, this.config);
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }

  /**
   * Get decrypted vault content as key-value object
   */
  private async getDecrypted(): Promise<Record<string, string>> {
    const vaultPath = resolveVaultPath(this.config);
    if (!fs.existsSync(vaultPath)) return {};
    const content = vaultView(vaultPath, this.config);
    return parseVaultContent(content);
  }

  /**
   * Set a secret in the vault file
   */
  async setSecret(name: string, value: string): Promise<SetSecretResult> {
    try {
      const vaultPath = resolveVaultPath(this.config);
      this.ensureVaultExists(vaultPath);

      const data = await this.getDecrypted();
      data[name] = value;

      const yamlContent = yaml.dump(data, { lineWidth: -1, noRefs: true });
      const tmpPath = path.join(os.tmpdir(), `factiii-vault-edit-${Date.now()}.yml`);
      fs.writeFileSync(tmpPath, yamlContent, 'utf8');

      vaultEncrypt(tmpPath, vaultPath, this.config);
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      return { success: true };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * Get a secret value from the vault
   */
  async getSecret(name: string): Promise<string | null> {
    try {
      const data = await this.getDecrypted();
      const v = data[name];
      return v ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Check which of the given secret names exist in the vault
   */
  async checkSecrets(names: string[]): Promise<CheckSecretsResult> {
    try {
      const data = await this.getDecrypted();
      const status: Record<string, boolean> = {};
      const missing: string[] = [];
      for (const name of names) {
        const exists = name in data && String(data[name] ?? '').trim().length > 0;
        status[name] = exists;
        if (!exists) missing.push(name);
      }
      return { status, missing };
    } catch (e) {
      return {
        error: e instanceof Error ? e.message : String(e),
        status: {},
        missing: names,
      };
    }
  }
}
