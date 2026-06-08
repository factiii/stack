/**
 * Ansible Vault Secrets
 *
 * Read, write, and check secrets stored in an Ansible Vault–encrypted YAML file.
 * Uses pure Node.js encryption (ansible-vault npm package) — no Python/CLI required.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import yaml from 'js-yaml';
import { isWrapped, unwrapPassword, wrapPassword, STACK_VAULT_HEADER } from './vault-key.js';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Vault } = require('ansible-vault') as { Vault: new (opts: { password: string }) => { encryptSync: (data: string) => string; decryptSync: (data: string) => string } };

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

// Single in-process cache so the CLI prompts for the vault passphrase at most
// once. Stored on globalThis so that even if this module is loaded multiple
// times (e.g. symlinked paths on Windows), all copies share the same cache.
const CACHE_KEY = Symbol.for('__factiii_vault_password__');
function getCachedPromise(): Promise<string> | null {
  return (globalThis as Record<symbol, Promise<string> | null>)[CACHE_KEY] ?? null;
}
function setCachedPromise(p: Promise<string> | null): void {
  (globalThis as Record<symbol, Promise<string> | null>)[CACHE_KEY] = p;
}

/**
 * Resolve the vault password for use with ansible-vault.
 *
 * Supports three storage formats, tried in order:
 *   1. ANSIBLE_VAULT_PASSWORD env var (plaintext, CI-friendly)
 *   2. STACK_VAULT_PASSPHRASE env var unwrapping a STACKVAULT1-headed file
 *   3. ~/.vault_pass on disk:
 *      - if first line is "STACKVAULT1": prompt the user for their passphrase
 *        and unwrap the inner ansible password (scrypt + AES-GCM)
 *      - otherwise: treat as legacy plaintext, and on first encounter offer
 *        to encrypt it now (gated by interactive TTY + no opt-out marker)
 *
 * Within a single process, the unwrapped password is cached so subsequent
 * calls don't re-prompt.
 */
export async function getVaultPasswordString(config: AnsibleVaultSecretsConfig): Promise<string> {
  // Priority 1: Direct env var (used by CI / scripted invocations).
  const envPass = getVaultPassword();
  if (envPass) return envPass;

  // Priority 2: Password file. Read raw, then decide format.
  const file = getVaultPasswordFile(config);
  if (!file) {
    throw new Error(
      'Vault password required. Set ansible.vault_password_file in stack.yml, or ANSIBLE_VAULT_PASSWORD_FILE / ANSIBLE_VAULT_PASSWORD env.'
    );
  }

  const cached = getCachedPromise();
  if (cached) return cached;

  const promise = resolveVaultPassword(file);
  setCachedPromise(promise);
  try {
    return await promise;
  } catch (e) {
    setCachedPromise(null);
    throw e;
  }
}

async function resolveVaultPassword(file: string): Promise<string> {
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');

  if (isWrapped(raw)) {
    const passphrase = process.env.STACK_VAULT_PASSPHRASE
      ?? await promptVaultPassphrase('   Vault passphrase: ');
    if (!passphrase) {
      throw new Error('Vault passphrase required (STACKVAULT1-wrapped ' + file + ')');
    }
    try {
      return await unwrapPassword(raw, passphrase);
    } catch {
      throw new Error('Failed to unwrap ' + file + ' — wrong passphrase or file is corrupt');
    }
  }

  // Legacy plaintext. Trim and use as-is. Optionally offer to encrypt now.
  const plain = raw.trim();
  await maybeOfferAutoEncrypt(file, plain);
  return plain;
}

/**
 * Prompt the user for the wrapping passphrase. Hidden input on TTY; falls back
 * to refusing in non-TTY contexts (CI must use STACK_VAULT_PASSPHRASE env).
 */
async function promptVaultPassphrase(prompt: string): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const { promptSingleLine } = await import('./secret-prompts.js');
  const value = await promptSingleLine(prompt, { hidden: true });
  return value || null;
}

/**
 * If the password file is plaintext and we're interactive, ask whether to
 * encrypt it. The user's "no" is remembered via a sidecar marker so we don't
 * keep nagging.
 */
async function maybeOfferAutoEncrypt(file: string, plaintextPassword: string): Promise<void> {
  if (process.env.STACK_VAULT_NO_ENCRYPT) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  const declineMarker = file + '.no_encrypt';
  if (fs.existsSync(declineMarker)) return;
  if (process.env.GITHUB_ACTIONS === 'true' || process.env.FACTIII_ON_SERVER === 'true') return;

  const { confirm, promptSingleLine } = await import('./secret-prompts.js');
  console.log('');
  console.log('   Your ' + file + ' is stored in plaintext.');
  console.log('   Encrypt it with a passphrase you\'ll be asked for in future commands?');
  const yes = await confirm('   Encrypt now?', true);
  if (!yes) {
    try {
      fs.writeFileSync(declineMarker, 'declined ' + new Date().toISOString() + '\n', { mode: 0o600 });
    } catch {
      // best effort; user can re-decline next time
    }
    return;
  }

  let passphrase = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const a = await promptSingleLine('   New passphrase: ', { hidden: true });
    const b = await promptSingleLine('   Confirm:        ', { hidden: true });
    if (!a || a !== b) {
      console.log('   Passphrases empty or did not match \u2014 try again');
      continue;
    }
    passphrase = a;
    break;
  }
  if (!passphrase) {
    console.log('   Skipping \u2014 vault password file remains plaintext');
    return;
  }

  const wrapped = await wrapPassword(plaintextPassword, passphrase);
  fs.writeFileSync(file, wrapped, { mode: 0o600 });
  console.log('   \u2705 Wrote wrapped password file (' + STACK_VAULT_HEADER + ') to ' + file);
  console.log('      Future commands will prompt for this passphrase.');
  console.log('      Remove ' + file + ' and recreate plaintext to roll back.');
}

/**
 * Decrypt an Ansible Vault–encrypted file (pure Node.js, no CLI)
 */
async function vaultView(vaultPath: string, config: AnsibleVaultSecretsConfig): Promise<string> {
  const password = await getVaultPasswordString(config);
  // Strip BOM and normalize line endings for cross-platform compatibility
  const vaultContent = fs.readFileSync(vaultPath, 'utf8')
    .replace(/^\uFEFF/, '')
    .trim();
  const v = new Vault({ password });
  try {
    return v.decryptSync(vaultContent);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('Integrity check failed')) {
      throw new Error(
        'Vault decryption failed — wrong password or vault was created with a different password.\n' +
        '   Vault file: ' + vaultPath + '\n' +
        '   Password file: ' + (config.vault_password_file ?? '(env var)') + '\n' +
        '   If vault was created on another machine, ensure the same password is in your password file.'
      );
    }
    throw e;
  }
}

/**
 * Encrypt a plaintext file to Ansible Vault format (pure Node.js, no CLI)
 */
async function vaultEncrypt(
  inputPath: string,
  outputPath: string,
  config: AnsibleVaultSecretsConfig
): Promise<void> {
  const password = await getVaultPasswordString(config);
  const plaintext = fs.readFileSync(inputPath, 'utf8');
  const v = new Vault({ password });
  const encrypted = v.encryptSync(plaintext);

  // CRITICAL: Verify round-trip before overwriting vault file
  // Why: ansible-vault npm package can produce corrupt output on some platforms
  // Breaks-if-changed: vault file gets silently corrupted, causing password mismatch errors
  const verifier = new Vault({ password });
  verifier.decryptSync(encrypted); // Throws if encryption produced corrupt output

  fs.writeFileSync(outputPath, encrypted + '\n', 'utf8');
}

/**
 * Parse decrypted vault content as YAML (flat key-value for backwards compatibility)
 */
function parseVaultContent(content: string): Record<string, string> {
  const parsed = yaml.load(content);
  if (parsed == null) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string') out[k] = v;
    else if (v != null && typeof v !== 'object') out[k] = String(v);
    // Skip nested objects in flat parsing
  }
  return out;
}

/**
 * Vault content structure supporting nested environment secrets
 */
export interface VaultContent {
  // SSH keys (legacy flat format)
  STAGING_SSH?: string;
  PROD_SSH?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  // Environment-specific secrets (new nested format)
  staging_envs?: Record<string, string>;
  prod_envs?: Record<string, string>;
  // Any other flat secrets
  [key: string]: string | Record<string, string> | undefined;
}

/**
 * Parse decrypted vault content as full YAML structure (supports nested objects)
 */
function parseVaultContentFull(content: string): VaultContent {
  const parsed = yaml.load(content);
  if (parsed == null) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as VaultContent;
}

/**
 * Ansible Vault–backed secret operations.
 * Uses pure Node.js encryption (no CLI). Password from config or ANSIBLE_VAULT_PASSWORD_FILE / ANSIBLE_VAULT_PASSWORD.
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
  private async ensureVaultExists(vaultPath: string): Promise<void> {
    if (fs.existsSync(vaultPath)) return;
    const dir = path.dirname(vaultPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(os.tmpdir(), `factiii-vault-${crypto.randomBytes(8).toString('hex')}.yml`);
    fs.writeFileSync(tmp, '# Factiii secrets\n{}\n', 'utf8');
    await vaultEncrypt(tmp, vaultPath, this.config);
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }

  /**
   * Get decrypted vault content as key-value object (flat, for backwards compatibility)
   */
  private async getDecrypted(): Promise<Record<string, string>> {
    const vaultPath = resolveVaultPath(this.config);
    if (!fs.existsSync(vaultPath)) return {};
    const content = await vaultView(vaultPath, this.config);
    return parseVaultContent(content);
  }

  /**
   * Get decrypted vault content as full structure (supports nested objects)
   */
  private async getDecryptedFull(): Promise<VaultContent> {
    const vaultPath = resolveVaultPath(this.config);
    if (!fs.existsSync(vaultPath)) return {};
    const content = await vaultView(vaultPath, this.config);
    return parseVaultContentFull(content);
  }

  /**
   * Save vault content (full structure)
   */
  private async saveVault(data: VaultContent): Promise<SetSecretResult> {
    try {
      const vaultPath = resolveVaultPath(this.config);
      await this.ensureVaultExists(vaultPath);

      const yamlContent = yaml.dump(data, { lineWidth: -1, noRefs: true });
      const tmpPath = path.join(os.tmpdir(), `factiii-vault-edit-${crypto.randomBytes(8).toString('hex')}.yml`);
      fs.writeFileSync(tmpPath, yamlContent, 'utf8');

      await vaultEncrypt(tmpPath, vaultPath, this.config);
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
   * Set a secret in the vault file
   */
  async setSecret(name: string, value: string): Promise<SetSecretResult> {
    try {
      const vaultPath = resolveVaultPath(this.config);
      await this.ensureVaultExists(vaultPath);

      const data = await this.getDecryptedFull();
      data[name] = value;

      return this.saveVault(data);
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
    } catch (e) {
      // Re-throw password mismatch — caller must handle (vault-password-mismatch scanfix)
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Integrity check failed') || msg.includes('wrong password')) throw e;
      return null;
    }
  }

  /**
   * Delete a secret from the vault
   */
  async deleteSecret(name: string): Promise<SetSecretResult> {
    try {
      const vaultPath = resolveVaultPath(this.config);
      await this.ensureVaultExists(vaultPath);

      const data = await this.getDecryptedFull();
      if (!(name in data)) {
        return { success: false, error: 'Secret not found: ' + name };
      }
      delete data[name];

      return this.saveVault(data);
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * Delete an environment secret from the vault
   */
  async deleteEnvironmentSecret(
    stage: 'staging' | 'prod',
    name: string
  ): Promise<SetSecretResult> {
    try {
      const vaultPath = resolveVaultPath(this.config);
      await this.ensureVaultExists(vaultPath);

      const data = await this.getDecryptedFull();
      const envKey = stage + '_envs';
      const envBlock = data[envKey];

      if (!envBlock || typeof envBlock !== 'string') {
        return { success: false, error: 'No environment secrets found for ' + stage };
      }

      const lines = envBlock.split('\n');
      const filtered = lines.filter(line => {
        const eqIndex = line.indexOf('=');
        if (eqIndex === -1) return true;
        return line.substring(0, eqIndex).trim() !== name;
      });

      if (filtered.length === lines.length) {
        return { success: false, error: name + ' not found in ' + stage + ' environment secrets' };
      }

      data[envKey] = filtered.join('\n');
      return this.saveVault(data);
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
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
      // Re-throw password mismatch — caller must handle (vault-password-mismatch scanfix)
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Integrity check failed') || msg.includes('wrong password')) throw e;
      return {
        error: msg,
        status: {},
        missing: names,
      };
    }
  }

  // ============================================================
  // ENVIRONMENT SECRETS - For deploy secrets feature
  // ============================================================

  /**
   * Get SSH key for a stage
   */
  async getSSHKey(stage: 'staging' | 'prod'): Promise<string | null> {
    const keyName = stage === 'staging' ? 'STAGING_SSH' : 'PROD_SSH';
    return this.getSecret(keyName);
  }

  /**
   * Get all environment secrets for a stage
   */
  async getEnvironmentSecrets(stage: 'staging' | 'prod'): Promise<Record<string, string>> {
    try {
      const data = await this.getDecryptedFull();
      const envKey = `${stage}_envs` as keyof VaultContent;
      const envs = data[envKey];

      if (typeof envs === 'object' && envs !== null && !Array.isArray(envs)) {
        return envs as Record<string, string>;
      }
      return {};
    } catch {
      return {};
    }
  }

  /**
   * Set an environment secret for a stage
   */
  async setEnvironmentSecret(
    stage: 'staging' | 'prod',
    name: string,
    value: string
  ): Promise<SetSecretResult> {
    try {
      const data = await this.getDecryptedFull();
      const envKey = `${stage}_envs`;

      // Initialize if not exists
      if (!data[envKey] || typeof data[envKey] !== 'object') {
        data[envKey] = {};
      }

      (data[envKey] as Record<string, string>)[name] = value;

      return this.saveVault(data);
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * Set multiple environment secrets for a stage at once
   */
  async setEnvironmentSecrets(
    stage: 'staging' | 'prod',
    secrets: Record<string, string>
  ): Promise<SetSecretResult> {
    try {
      const data = await this.getDecryptedFull();
      const envKey = `${stage}_envs`;

      // Initialize if not exists
      if (!data[envKey] || typeof data[envKey] !== 'object') {
        data[envKey] = {};
      }

      // Merge secrets
      Object.assign(data[envKey] as Record<string, string>, secrets);

      return this.saveVault(data);
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * List all environment secret keys for a stage (not values)
   */
  async listEnvironmentSecretKeys(stage: 'staging' | 'prod'): Promise<string[]> {
    const envs = await this.getEnvironmentSecrets(stage);
    return Object.keys(envs);
  }

  /**
   * Check if environment secrets exist for a stage
   */
  async hasEnvironmentSecrets(stage: 'staging' | 'prod'): Promise<boolean> {
    const keys = await this.listEnvironmentSecretKeys(stage);
    return keys.length > 0;
  }
}

