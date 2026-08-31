import { describe, it, expect } from 'vitest';
import {
  signupSchema,
  signupSchemaOptionalUsername,
  loginSchema,
  resetPasswordSchema,
  changePasswordSchema,
  twoFaVerifySchema,
  verifyEmailSchema,
  requestPasswordResetSchema,
  createSchemas,
} from '../src/validators';
import { z } from 'zod';

describe('createSchemas usernameMode', () => {
  const noUsername = { email: 'test@example.com', password: 'pass1234' };

  it('DEFAULTS to optional — signup takes email + password alone', () => {
    // Asserted rather than assumed: the default is the behaviour every consumer
    // that configures nothing inherits, and it CHANGED in 0.20.0 (it used to be
    // 'required'). A username-first consumer must now opt in explicitly, and if
    // a refactor ever moves this default again the break should surface here
    // rather than in someone's signup flow.
    expect(createSchemas().signup.parse(noUsername)).toEqual(noUsername);
  });

  it("required mode rejects a missing username", () => {
    expect(() => createSchemas(undefined, 'required').signup.parse(noUsername)).toThrow();
  });

  it('optional mode accepts a missing username', () => {
    expect(createSchemas(undefined, 'optional').signup.parse(noUsername)).toEqual(noUsername);
  });

  it('keeps schema extensions in both modes', () => {
    const ext = { signup: z.object({ referral: z.string() }) };
    const withName = { ...noUsername, username: 'testuser', referral: 'abc' };
    expect(createSchemas(ext, 'required').signup.parse(withName)).toEqual(withName);
    expect(createSchemas(ext, 'optional').signup.parse({ ...noUsername, referral: 'abc' })).toEqual(
      { ...noUsername, referral: 'abc' }
    );
  });
});

describe('signupSchema', () => {
  const valid = { username: 'testuser', email: 'test@example.com', password: 'pass1234' };

  it('accepts valid input', () => {
    expect(signupSchema.parse(valid)).toEqual(valid);
  });

  it('rejects empty username', () => {
    expect(() => signupSchema.parse({ ...valid, username: '' })).toThrow();
  });

  it('REJECTS input with no username — signupSchema is the required-mode base', () => {
    const { username: _username, ...noUsername } = valid;
    expect(() => signupSchema.parse(noUsername)).toThrow();
  });

  it('accepts input with no username under the optional-mode schema', () => {
    const { username: _username, ...noUsername } = valid;
    expect(signupSchemaOptionalUsername.parse(noUsername)).toEqual(noUsername);
  });

  it('still validates a supplied username in optional mode', () => {
    expect(() =>
      signupSchemaOptionalUsername.parse({ ...valid, username: 'bad name' })
    ).toThrow();
  });

  it('still validates a username that is supplied', () => {
    expect(() => signupSchema.parse({ ...valid, username: 'bad name' })).toThrow();
  });

  it('rejects username over 30 chars', () => {
    expect(() => signupSchema.parse({ ...valid, username: 'a'.repeat(31) })).toThrow();
  });

  it('rejects username with special chars', () => {
    expect(() => signupSchema.parse({ ...valid, username: 'user@name' })).toThrow();
  });

  it('allows underscores in username', () => {
    expect(signupSchema.parse({ ...valid, username: 'test_user_1' })).toBeDefined();
  });

  it('rejects invalid email', () => {
    expect(() => signupSchema.parse({ ...valid, email: 'notanemail' })).toThrow();
  });

  it('rejects email over 254 chars', () => {
    const longEmail = 'a'.repeat(250) + '@b.co';
    expect(() => signupSchema.parse({ ...valid, email: longEmail })).toThrow();
  });

  it('rejects password under 6 chars', () => {
    expect(() => signupSchema.parse({ ...valid, password: 'abc' })).toThrow();
  });

  it('rejects password over 72 chars', () => {
    expect(() => signupSchema.parse({ ...valid, password: 'a'.repeat(73) })).toThrow();
  });

  it('rejects whitespace-only password', () => {
    expect(() => signupSchema.parse({ ...valid, password: '       ' })).toThrow();
  });
});

describe('loginSchema', () => {
  it('accepts valid input', () => {
    expect(loginSchema.parse({ username: 'user', password: 'pass' })).toBeDefined();
  });

  it('accepts optional 2fa code', () => {
    const result = loginSchema.parse({ username: 'user', password: 'pass', code: '123456' });
    expect(result.code).toBe('123456');
  });

  it('rejects empty username', () => {
    expect(() => loginSchema.parse({ username: '', password: 'pass' })).toThrow();
  });

  it('rejects empty password', () => {
    expect(() => loginSchema.parse({ username: 'user', password: '' })).toThrow();
  });
});

describe('resetPasswordSchema', () => {
  it('accepts valid input', () => {
    expect(resetPasswordSchema.parse({ token: 'abc-123', password: 'newpass1' })).toBeDefined();
  });

  it('rejects empty token', () => {
    expect(() => resetPasswordSchema.parse({ token: '', password: 'newpass1' })).toThrow();
  });

  it('rejects short password', () => {
    expect(() => resetPasswordSchema.parse({ token: 'abc', password: 'ab' })).toThrow();
  });
});

describe('changePasswordSchema', () => {
  it('accepts valid input', () => {
    expect(
      changePasswordSchema.parse({ currentPassword: 'old', newPassword: 'newpass1' })
    ).toBeDefined();
  });

  it('rejects empty current password', () => {
    expect(() =>
      changePasswordSchema.parse({ currentPassword: '', newPassword: 'newpass1' })
    ).toThrow();
  });
});

describe('twoFaVerifySchema', () => {
  it('accepts valid code', () => {
    expect(twoFaVerifySchema.parse({ code: '123456' })).toBeDefined();
  });

  it('accepts optional sessionId', () => {
    const result = twoFaVerifySchema.parse({ code: '123456', sessionId: 1 });
    expect(result.sessionId).toBe(1);
  });

  it('rejects code shorter than 6', () => {
    expect(() => twoFaVerifySchema.parse({ code: '12345' })).toThrow();
  });
});

describe('verifyEmailSchema', () => {
  it('accepts valid code', () => {
    expect(verifyEmailSchema.parse({ code: 'abc123' })).toBeDefined();
  });

  it('rejects empty code', () => {
    expect(() => verifyEmailSchema.parse({ code: '' })).toThrow();
  });
});

describe('requestPasswordResetSchema', () => {
  it('accepts valid email', () => {
    expect(requestPasswordResetSchema.parse({ email: 'a@b.com' })).toBeDefined();
  });

  it('rejects invalid email', () => {
    expect(() => requestPasswordResetSchema.parse({ email: 'not-email' })).toThrow();
  });
});

describe('createSchemas', () => {
  it('returns base schemas when no extensions', () => {
    const schemas = createSchemas();
    expect(schemas.signup).toBeDefined();
    expect(schemas.login).toBeDefined();
    expect(schemas.oauth).toBeDefined();
  });

  it('merges signup extension fields', () => {
    const ext = { signup: z.object({ referralCode: z.string() }) };
    const schemas = createSchemas(ext);
    const result = schemas.signup.parse({
      username: 'user',
      email: 'a@b.com',
      password: 'pass1234',
      referralCode: 'REF1',
    });
    expect(result.referralCode).toBe('REF1');
  });
});
