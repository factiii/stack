import { describe, it, expect } from 'vitest';
import { hashPassword, comparePassword, validatePasswordStrength } from '../src/utilities/password';

describe('hashPassword / comparePassword', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('mypassword');
    expect(hash).not.toBe('mypassword');
    expect(await comparePassword('mypassword', hash)).toBe(true);
  });

  it('rejects wrong password', async () => {
    const hash = await hashPassword('mypassword');
    expect(await comparePassword('wrongpassword', hash)).toBe(false);
  });

  it('is case sensitive', async () => {
    const hash = await hashPassword('MyPassword');
    expect(await comparePassword('mypassword', hash)).toBe(false);
    expect(await comparePassword('MyPassword', hash)).toBe(true);
  });

  it('handles special characters', async () => {
    const password = '!@#$%^&*()_+-=[]{}|;:,.<>?';
    const hash = await hashPassword(password);
    expect(await comparePassword(password, hash)).toBe(true);
  });

  it('handles unicode characters', async () => {
    const password = 'pässwörd_日本語';
    const hash = await hashPassword(password);
    expect(await comparePassword(password, hash)).toBe(true);
  });

  it('produces different hashes for same password (salting)', async () => {
    const hash1 = await hashPassword('same');
    const hash2 = await hashPassword('same');
    expect(hash1).not.toBe(hash2);
    // Both should still verify
    expect(await comparePassword('same', hash1)).toBe(true);
    expect(await comparePassword('same', hash2)).toBe(true);
  });
});

describe('validatePasswordStrength', () => {
  it('accepts a valid password', () => {
    expect(validatePasswordStrength('abcdef')).toEqual({ valid: true });
  });

  it('rejects password shorter than default min (6)', () => {
    const result = validatePasswordStrength('abc');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('6');
  });

  it('rejects password shorter than custom min', () => {
    const result = validatePasswordStrength('abcdefgh', 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('10');
  });

  it('accepts password at exact min length', () => {
    expect(validatePasswordStrength('abcdef', 6)).toEqual({ valid: true });
  });

  it('rejects empty string', () => {
    expect(validatePasswordStrength('').valid).toBe(false);
  });
});
