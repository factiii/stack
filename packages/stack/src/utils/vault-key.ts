/**
 * Vault Password Wrapping
 *
 * Adds a passphrase-encryption layer on top of `~/.vault_pass`. The actual
 * Ansible Vault password remains the single string ansible-vault expects;
 * we just optionally wrap it on disk so that a casual read of `~/.vault_pass`
 * doesn't yield a working password.
 *
 * On-disk format (one file, two lines):
 *   STACKVAULT1
 *   <base64( salt(32) | nonce(12) | gcm-tag(16) | ciphertext )>
 *
 * Crypto:
 *   - KEK = scrypt(passphrase, salt, 32 bytes, N=2^17 r=8 p=1)   ~250ms
 *   - AEAD = AES-256-GCM(KEK, nonce)
 *
 * The passphrase is never persisted. KDF cost is intentionally high to make
 * brute-forcing a stolen `~/.vault_pass` expensive.
 */
import * as crypto from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions
) => Promise<Buffer>;

export const STACK_VAULT_HEADER = 'STACKVAULT1';

const SALT_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
// N=2^17 ≈ 250ms on M-series, ~256MB peak. Bump maxmem so node doesn't refuse.
const SCRYPT_OPTS: crypto.ScryptOptions = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

export function isWrapped(contents: string): boolean {
  // First non-empty line must be the header. Tolerates BOM and leading whitespace.
  const firstLine = contents.replace(/^﻿/, '').trimStart().split('\n', 1)[0]?.trim() ?? '';
  return firstLine === STACK_VAULT_HEADER;
}

/**
 * Encrypt a vault password (the plaintext string ansible-vault wants) with a
 * user-chosen passphrase. Returns the file contents to write to ~/.vault_pass.
 */
export async function wrapPassword(plaintext: string, passphrase: string): Promise<string> {
  if (!passphrase) throw new Error('Passphrase cannot be empty');
  const salt = crypto.randomBytes(SALT_BYTES);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const kek = await scryptAsync(passphrase.normalize('NFKC'), salt, KEY_BYTES, SCRYPT_OPTS);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([salt, nonce, tag, ciphertext]);
  // Best-effort scrub of the derived key.
  kek.fill(0);
  return STACK_VAULT_HEADER + '\n' + blob.toString('base64') + '\n';
}

/**
 * Decrypt a wrapped ~/.vault_pass and return the inner vault password.
 *
 * Throws on bad passphrase or tampered file (gcm tag fails) — caller is
 * expected to surface the error and re-prompt.
 */
export async function unwrapPassword(fileContents: string, passphrase: string): Promise<string> {
  if (!isWrapped(fileContents)) {
    throw new Error('Not a wrapped vault password file');
  }
  const lines = fileContents.replace(/^﻿/, '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('Wrapped vault file is missing the ciphertext line');
  const blob = Buffer.from(lines[1] as string, 'base64');
  if (blob.length < SALT_BYTES + NONCE_BYTES + TAG_BYTES + 1) {
    throw new Error('Wrapped vault file is truncated');
  }

  const salt = blob.subarray(0, SALT_BYTES);
  const nonce = blob.subarray(SALT_BYTES, SALT_BYTES + NONCE_BYTES);
  const tag = blob.subarray(SALT_BYTES + NONCE_BYTES, SALT_BYTES + NONCE_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(SALT_BYTES + NONCE_BYTES + TAG_BYTES);

  const kek = await scryptAsync(passphrase.normalize('NFKC'), Buffer.from(salt), KEY_BYTES, SCRYPT_OPTS);
  const decipher = crypto.createDecipheriv('aes-256-gcm', kek, nonce);
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } finally {
    kek.fill(0);
  }
  return plaintext.toString('utf8');
}
