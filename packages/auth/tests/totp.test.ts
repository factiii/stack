import { describe, it, expect } from 'vitest';
import {
  generateTotpSecret,
  cleanBase32String,
  generateTotpCode,
  verifyTotp,
  generateOtp,
} from '../src/utilities/totp';

describe('generateTotpSecret', () => {
  it('generates a secret of default length 16', () => {
    const secret = generateTotpSecret();
    expect(secret).toHaveLength(16);
  });

  it('generates a secret of custom length', () => {
    const secret = generateTotpSecret(32);
    expect(secret).toHaveLength(32);
  });

  it('only contains valid base32 characters', () => {
    const secret = generateTotpSecret(100);
    expect(secret).toMatch(/^[A-Z2-7]+$/);
  });

  it('generates unique secrets', () => {
    const secrets = new Set(Array.from({ length: 20 }, () => generateTotpSecret()));
    expect(secrets.size).toBe(20);
  });
});

describe('cleanBase32String', () => {
  it('removes invalid characters', () => {
    expect(cleanBase32String('AB CD-EF!12')).toBe('ABCDEF2');
  });

  it('uppercases lowercase input', () => {
    expect(cleanBase32String('abcdef')).toBe('ABCDEF');
  });

  it('keeps valid base32 unchanged', () => {
    expect(cleanBase32String('ABCDEFGHIJKLMNOP')).toBe('ABCDEFGHIJKLMNOP');
  });

  it('handles empty string', () => {
    expect(cleanBase32String('')).toBe('');
  });
});

describe('generateTotpCode / verifyTotp', () => {
  it('generates a 6-digit code and verifies it', async () => {
    const secret = generateTotpSecret();
    const code = await generateTotpCode(secret);
    expect(code).toMatch(/^\d{6}$/);
    expect(await verifyTotp(code, secret)).toBe(true);
  });

  it('rejects an incorrect code', async () => {
    const secret = generateTotpSecret();
    expect(await verifyTotp('000000', secret)).toBe(false);
  });

  it('strips whitespace from code before verifying', async () => {
    const secret = generateTotpSecret();
    const code = await generateTotpCode(secret);
    const spaced = code.slice(0, 3) + ' ' + code.slice(3);
    expect(await verifyTotp(spaced, secret)).toBe(true);
  });
});

describe('generateOtp', () => {
  it('generates a 6-digit number by default', () => {
    const otp = generateOtp();
    expect(otp).toBeGreaterThanOrEqual(100000);
    expect(otp).toBeLessThanOrEqual(999999);
  });

  it('respects custom min/max', () => {
    const otp = generateOtp(1000, 9999);
    expect(otp).toBeGreaterThanOrEqual(1000);
    expect(otp).toBeLessThanOrEqual(9999);
  });

  it('generates varying values', () => {
    const otps = new Set(Array.from({ length: 20 }, () => generateOtp()));
    expect(otps.size).toBeGreaterThan(1);
  });
});
