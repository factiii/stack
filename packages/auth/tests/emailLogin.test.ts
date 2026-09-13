import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { initTRPC } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AuthEmailLoginAttempt,
  AuthMagicLink,
  AuthUser,
  CreateEmailLoginAttemptData,
  CreateUserData,
} from '../src/adapters/database';
import { BaseProcedureFactory } from '../src/procedures/base';
import { EmailLoginProcedureFactory } from '../src/procedures/emailLogin';
import { MagicLinkProcedureFactory } from '../src/procedures/magicLink';
import { OAuthLoginProcedureFactory } from '../src/procedures/oauth';
import { requiresDeviceStep } from '../src/procedures/twoFa/deviceStep';
import type { AuthProcedure, BaseProcedure, TrpcContext } from '../src/types/trpc';
import { createAuthConfig } from '../src/utilities/config';
import { hashPassword } from '../src/utilities/password';
import { createSchemas } from '../src/validators';

/**
 * Email sign-in, and the factor-class gate every sign-in path now runs.
 *
 * The procedures run for real against in-memory adapters that return full rows.
 * The attempt and magic-link stores make their check-and-write without an `await`
 * in between, so under one event loop they are as atomic as the conditional
 * UPDATE the Prisma adapter uses — which is what lets the race tests mean
 * something: two verifies really do interleave at every other `await`.
 */

const { googleVerify } = vi.hoisted(() => ({ googleVerify: vi.fn() }));

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    verifyIdToken = googleVerify;
  },
}));

// Imported by the verifier; never exercised here.
vi.mock('apple-signin-auth', () => ({ default: { verifyIdToken: vi.fn() } }));

const TWO_FA_SECRET = 'JBSWY3DPEHPK3PXP';
const BACKUP_CODE = 'a1b2c3d4e5';
const OAKBOX = {
  siteUrl: 'https://oakbox.me',
  verifyPath: '/auth/email',
  resetPath: '/reset-password',
  brand: 'oakbox',
};

const CODE_DID_NOT_WORK = 'That code did not work. Check it and try again.';
const LINK_EXPIRED = 'That link has expired. Ask for a new one.';

type UserRow = AuthUser & { twoFaBackupCodes: string[] };

const account = (overrides: Partial<UserRow> = {}): UserRow => ({
  id: 7,
  status: 'ACTIVE',
  email: 'ada@example.com',
  username: 'ada',
  password: null,
  twoFaSecret: null,
  twoFaBackupCodes: [],
  tag: 'HUMAN',
  verifiedHumanAt: null,
  emailVerificationStatus: 'VERIFIED',
  otpForEmailVerification: null,
  isActive: true,
  updatedAt: new Date('2026-01-01'),
  ...overrides,
});

const withTwoFa = (overrides: Partial<UserRow> = {}) =>
  account({ twoFaSecret: TWO_FA_SECRET, twoFaBackupCodes: [BACKUP_CODE], ...overrides });

interface HarnessOptions {
  users?: UserRow[];
  allow?: (key: string) => boolean;
  hooks?: Record<string, unknown>;
  linkedUserId?: number;
  /** Runs inside user.create before its uniqueness check — lets a test play the other racer. */
  beforeCreate?: (data: CreateUserData) => void;
}

function harness(opts: HarnessOptions = {}) {
  const users: UserRow[] = [...(opts.users ?? [])];
  const attempts: AuthEmailLoginAttempt[] = [];
  const magicLinks: AuthMagicLink[] = [];
  const sent: Array<{ to: string; app: string; brand: string; link: string; code: string }> = [];

  const byEmail = (email: string) =>
    users.find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
  const isOpen = (a: AuthEmailLoginAttempt) => a.consumedAt === null && a.expiresAt > new Date();

  const database = {
    user: {
      findByEmailInsensitive: vi.fn(async (email: string) => byEmail(email)),
      findByEmailOrUsernameInsensitive: vi.fn(
        async (identifier: string) =>
          byEmail(identifier) ??
          users.find((u) => u.username?.toLowerCase() === identifier.toLowerCase()) ??
          null
      ),
      findById: vi.fn(async (id: number) => users.find((u) => u.id === id) ?? null),
      findActiveById: vi.fn(
        async (id: number) => users.find((u) => u.id === id && u.status === 'ACTIVE') ?? null
      ),
      create: vi.fn(async (data: CreateUserData) => {
        opts.beforeCreate?.(data);
        if (byEmail(data.email)) {
          throw Object.assign(new Error('Unique constraint failed on the fields: (`email`)'), {
            code: 'P2002',
          });
        }
        const row = account({ ...data, id: 100 + users.length });
        users.push(row);
        return row;
      }),
      update: vi.fn(async (id: number, data: Partial<UserRow>) => {
        const row = users.find((u) => u.id === id);
        if (!row) throw new Error('no user');
        Object.assign(row, data);
        return row;
      }),
      consumeBackupCode: vi.fn(async (id: number, code: string) => {
        const row = users.find((u) => u.id === id);
        const index = row ? row.twoFaBackupCodes.indexOf(code) : -1;
        if (!row || index === -1) return false;
        row.twoFaBackupCodes.splice(index, 1);
        return true;
      }),
    },
    session: {
      create: vi.fn(async (data: { userId: number }) => ({ id: 500, userId: data.userId })),
      findManyByIds: vi.fn(async () => []),
      revoke: vi.fn(async () => {}),
    },
    passwordReset: {
      deleteAllByUserId: vi.fn(async () => {}),
      create: vi.fn(async (userId: number) => ({ id: 'reset-1', createdAt: new Date(), userId })),
    },
    emailLoginAttempt: {
      create: vi.fn(async (data: CreateEmailLoginAttemptData) => {
        const row: AuthEmailLoginAttempt = {
          ...data,
          attempts: 0,
          consumedAt: null,
          createdAt: new Date(),
        };
        attempts.push(row);
        return row;
      }),
      findByTokenHash: vi.fn(async (hash: string) => attempts.find((a) => a.tokenHash === hash) ?? null),
      findLatestOpenByEmail: vi.fn(
        async (email: string) => [...attempts].reverse().find((a) => a.email === email && isOpen(a)) ?? null
      ),
      consume: vi.fn(async (id: string) => {
        const row = attempts.find((a) => a.id === id);
        if (!row || !isOpen(row)) return false;
        row.consumedAt = new Date();
        return true;
      }),
      incrementAttempts: vi.fn(async (id: string) => {
        const row = attempts.find((a) => a.id === id);
        if (!row) throw new Error('no attempt');
        row.attempts += 1;
        return row.attempts;
      }),
      consumeOpenByEmail: vi.fn(async (email: string) => {
        for (const row of attempts) {
          if (row.email === email && row.consumedAt === null) row.consumedAt = new Date();
        }
      }),
    },
    magicLink: {
      findById: vi.fn(async (id: string) => magicLinks.find((l) => l.id === id) ?? null),
      create: vi.fn(),
      markUsed: vi.fn(),
      consume: vi.fn(async (id: string) => {
        const row = magicLinks.find((l) => l.id === id);
        if (!row || row.usedAt || row.expiresAt <= new Date()) return false;
        row.usedAt = new Date();
        return true;
      }),
    },
  };

  const oauthAccounts = {
    resolve: vi.fn(async () => (opts.linkedUserId ? { userId: opts.linkedUserId } : null)),
    link: vi.fn(async () => {}),
    list: vi.fn(async () => []),
    unlink: vi.fn(async () => {}),
  };

  const emailService = {
    sendVerificationEmail: vi.fn(async () => {}),
    sendPasswordResetEmail: vi.fn(async () => {}),
    sendOTPEmail: vi.fn(async () => {}),
    sendLoginEmail: vi.fn(async (params: (typeof sent)[number]) => {
      sent.push(params);
    }),
  };

  // Counts the way a consumer's limiter does: allowed while the calls for a key
  // stay within `max`. `allow` can still refuse a key outright.
  const counts = new Map<string, number>();
  const rateLimit = vi.fn(async (key: string, max: number) => {
    if (opts.allow && !opts.allow(key)) return false;
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next <= max;
  });

  const config = createAuthConfig({
    database,
    secrets: { jwt: 'test-secret-key' },
    features: { twoFa: true, emailLogin: true, magicLink: true, oauth: { google: true } },
    emailService,
    emailLogin: { apps: { oakbox: OAKBOX }, pepper: 'p'.repeat(32), rateLimit, responseFloorMs: 0 },
    magicLink: { siteUrl: 'https://example.com' },
    oauthKeys: { google: { clientId: 'google-client' } },
    oauthAccounts,
    hooks: opts.hooks,
  } as unknown as Parameters<typeof createAuthConfig>[0]);

  const t = initTRPC.context<TrpcContext>().create();
  const procedure = t.procedure as unknown as BaseProcedure;
  const authProcedure = t.procedure as unknown as AuthProcedure;
  const router = t.router({
    emailLogin: t.router(new EmailLoginProcedureFactory(config, procedure).createEmailLoginProcedures()),
    ...new MagicLinkProcedureFactory(config, procedure).createMagicLinkProcedures(),
    ...new OAuthLoginProcedureFactory(config, procedure, authProcedure).createOAuthLoginProcedures(
      createSchemas()
    ),
    ...new BaseProcedureFactory(config, procedure, authProcedure).createBaseProcedures(createSchemas()),
  });

  const ctx = {
    headers: { 'user-agent': 'Mozilla/5.0' },
    res: { setHeader: vi.fn() },
    userId: null,
    sessionId: null,
    socketId: null,
    ip: '203.0.113.9',
  } as unknown as TrpcContext;

  const lastEmail = () => {
    const email = sent[sent.length - 1];
    if (!email) throw new Error('no email was sent');
    return { ...email, token: new URL(email.link).searchParams.get('token') ?? '' };
  };

  return {
    caller: t.createCallerFactory(router)(ctx),
    /** The same router, called from another IP. */
    callerAt: (ip: string) => t.createCallerFactory(router)({ ...ctx, ip } as TrpcContext),
    config,
    database,
    users,
    attempts,
    magicLinks,
    sent,
    lastEmail,
    emailService,
    oauthAccounts,
  };
}

beforeEach(() => {
  googleVerify.mockReset();
});

describe('emailLogin.request', () => {
  it('answers the same for an address with an account and one without', async () => {
    const h = harness({ users: [account()] });

    const known = await h.caller.emailLogin.request({ email: ' Ada@Example.com ', app: 'oakbox' });
    const unknown = await h.caller.emailLogin.request({ email: 'nobody@example.com', app: 'oakbox' });

    expect(known).toEqual({ sent: true });
    expect(unknown).toEqual(known);
    expect(h.sent.map((e) => e.to)).toEqual(['ada@example.com', 'nobody@example.com']);
    const email = h.lastEmail();
    expect(email.link.startsWith('https://oakbox.me/auth/email?token=')).toBe(true);
    expect(email.code).toMatch(/^\d{6}$/);
    expect(email.brand).toBe('oakbox');
  });

  it('stores neither the token nor the code', async () => {
    const h = harness();
    await h.caller.emailLogin.request({ email: 'ada@example.com', app: 'oakbox' });

    const { token, code } = h.lastEmail();
    const stored = JSON.stringify(h.attempts);
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(`"${code}"`);
  });

  it('sends nothing when rate-limited, and still answers { sent: true }', async () => {
    const h = harness({ allow: (key) => !key.startsWith('emailLogin:request:email:') });

    await expect(
      h.caller.emailLogin.request({ email: 'ada@example.com', app: 'oakbox' })
    ).resolves.toEqual({ sent: true });

    expect(h.sent).toHaveLength(0);
    expect(h.attempts).toHaveLength(0);
  });

  it('refuses an app key the server does not list', async () => {
    const h = harness();

    await expect(
      h.caller.emailLogin.request({ email: 'ada@example.com', app: 'somewhere-else' })
    ).rejects.toThrow('Unknown app.');
    expect(h.sent).toHaveLength(0);
  });

  it('a newer request spends the older attempt', async () => {
    const h = harness({ users: [account()] });
    await h.caller.emailLogin.request({ email: 'ada@example.com', app: 'oakbox' });
    const first = h.lastEmail();
    await h.caller.emailLogin.request({ email: 'ada@example.com', app: 'oakbox' });
    const second = h.lastEmail();

    await expect(h.caller.emailLogin.verifyLink({ token: first.token })).rejects.toThrow(LINK_EXPIRED);
    await expect(h.caller.emailLogin.verifyLink({ token: second.token })).resolves.toMatchObject({
      success: true,
    });
  });
});

const uniqueError = (fields: Record<string, unknown>) =>
  Object.assign(new Error('Unique constraint failed'), fields);

describe('account creation with a taken username', () => {
  it('tries a fresh username when the generated one is taken', async () => {
    let calls = 0;
    const h = harness({
      beforeCreate: () => {
        calls += 1;
        if (calls === 1) throw uniqueError({ code: 'P2002', meta: { target: ['username'] } });
      },
    });
    await h.caller.emailLogin.request({ email: 'fresh@example.com', app: 'oakbox' });
    const { code } = h.lastEmail();

    const result = await h.caller.emailLogin.verifyCode({ email: 'fresh@example.com', code });

    expect(result).toMatchObject({ success: true, created: true });
    expect(h.database.user.create).toHaveBeenCalledTimes(2);
    expect(h.users).toHaveLength(1);
  });

  it('an unnamed unique violation with no account for the address counts as a taken username', async () => {
    let calls = 0;
    const h = harness({
      beforeCreate: () => {
        calls += 1;
        if (calls === 1) throw uniqueError({ code: '23505' });
      },
    });
    await h.caller.emailLogin.request({ email: 'fresh@example.com', app: 'oakbox' });
    const { token } = h.lastEmail();

    await expect(h.caller.emailLogin.verifyLink({ token })).resolves.toMatchObject({
      success: true,
      created: true,
    });
    expect(h.database.user.create).toHaveBeenCalledTimes(2);
  });

  it('gives up after five taken usernames, logs it, and signs nobody in', async () => {
    const logError = vi.fn(async () => {});
    const h = harness({
      hooks: { logError },
      beforeCreate: () => {
        throw uniqueError({ code: 'P2002', meta: { target: ['username'] } });
      },
    });
    await h.caller.emailLogin.request({ email: 'fresh@example.com', app: 'oakbox' });
    const { code } = h.lastEmail();

    await expect(
      h.caller.emailLogin.verifyCode({ email: 'fresh@example.com', code })
    ).rejects.toThrow('Could not create the account. Try again.');
    expect(h.database.user.create).toHaveBeenCalledTimes(5);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(h.database.session.create).not.toHaveBeenCalled();
  });

  it('an email violation named by node-postgres still recovers as a lost race', async () => {
    let raced = false;
    const h = harness({
      beforeCreate: (data) => {
        if (raced) return;
        raced = true;
        h.users.push(account({ id: 55, email: data.email, username: 'winner' }));
        throw uniqueError({ code: '23505', constraint: 'User_email_key' });
      },
    });
    await h.caller.emailLogin.request({ email: 'twice@example.com', app: 'oakbox' });
    const { token } = h.lastEmail();

    await expect(h.caller.emailLogin.verifyLink({ token })).resolves.toMatchObject({
      success: true,
      created: false,
      user: { id: 55 },
    });
    expect(h.database.user.create).toHaveBeenCalledTimes(1);
  });
});

describe('emailLogin.peekLink', () => {
  it('names the address of an open link without spending it', async () => {
    const h = harness({ users: [account()] });
    await h.caller.emailLogin.request({ email: 'ada@example.com', app: 'oakbox' });
    const { token } = h.lastEmail();

    await expect(h.caller.emailLogin.peekLink({ token })).resolves.toEqual({
      valid: true,
      maskedEmail: 'a•••@example.com',
    });
    expect(h.attempts[0]?.consumedAt).toBeNull();
    await expect(h.caller.emailLogin.verifyLink({ token })).resolves.toMatchObject({ success: true });
  });

  it('says nothing for a spent, an expired or an unknown link', async () => {
    const h = harness();
    await h.caller.emailLogin.request({ email: 'new@example.com', app: 'oakbox' });
    const spent = h.lastEmail().token;
    await h.caller.emailLogin.verifyLink({ token: spent });
    await expect(h.caller.emailLogin.peekLink({ token: spent })).resolves.toEqual({ valid: false });

    await h.caller.emailLogin.request({ email: 'late@example.com', app: 'oakbox' });
    const expired = h.lastEmail().token;
    h.attempts[h.attempts.length - 1]!.expiresAt = new Date(Date.now() - 1000);
    await expect(h.caller.emailLogin.peekLink({ token: expired })).resolves.toEqual({ valid: false });

    await expect(h.caller.emailLogin.peekLink({ token: 'not-a-token' })).resolves.toEqual({
      valid: false,
    });
  });

  it('answers { valid: false } past the per-IP limit', async () => {
    const h = harness({
      users: [account()],
      allow: (key) => !key.startsWith('emailLogin:peek:'),
    });
    await h.caller.emailLogin.request({ email: 'ada@example.com', app: 'oakbox' });
    const { token } = h.lastEmail();

    await expect(h.caller.emailLogin.peekLink({ token })).resolves.toEqual({ valid: false });
  });
});

describe('maskEmail', () => {
  it('keeps the first character and the domain, and hides a +tag', async () => {
    const { maskEmail } = await import('../src/procedures/emailLogin');
    expect(maskEmail('ada@example.com')).toBe('a•••@example.com');
    expect(maskEmail('a@x.io')).toBe('a•••@x.io');
    expect(maskEmail('ada+box@example.com')).toBe('a•••@example.com');
    expect(maskEmail('not-an-email')).toBe('•••');
  });
});

describe('emailLogin.verifyLink / verifyCode', () => {
  it('the link and the code are one attempt: whichever arrives first spends both', async () => {
    const h = harness({ users: [account()] });
    await h.caller.emailLogin.request({ email: 'ada@example.com', app: 'oakbox' });
    const { token, code } = h.lastEmail();

    await expect(h.caller.emailLogin.verifyLink({ token })).resolves.toMatchObject({
      success: true,
      created: false,
      user: { id: 7 },
    });
    await expect(
      h.caller.emailLogin.verifyCode({ email: 'ada@example.com', code })
    ).rejects.toThrow(CODE_DID_NOT_WORK);
  });

  it('two requests racing on one link sign in once', async () => {
    const h = harness({ users: [account()] });
    await h.caller.emailLogin.request({ email: 'ada@example.com', app: 'oakbox' });
    const { token } = h.lastEmail();

    const results = await Promise.allSettled([
      h.caller.emailLogin.verifyLink({ token }),
      h.caller.emailLogin.verifyLink({ token }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(h.database.session.create).toHaveBeenCalledTimes(1);
  });

  it('refuses the sixth code even when it is the right one', async () => {
    const h = harness({ users: [account()] });
    await h.caller.emailLogin.request({ email: 'ada@example.com', app: 'oakbox' });
    const { code } = h.lastEmail();
    const wrong = code === '000000' ? '111111' : '000000';

    for (let i = 0; i < 5; i += 1) {
      await expect(
        h.caller.emailLogin.verifyCode({ email: 'ada@example.com', code: wrong })
      ).rejects.toThrow(CODE_DID_NOT_WORK);
    }
    await expect(
      h.caller.emailLogin.verifyCode({ email: 'ada@example.com', code })
    ).rejects.toThrow(CODE_DID_NOT_WORK);
    expect(h.database.session.create).not.toHaveBeenCalled();
  });

  it('refuses an expired attempt by link and by code', async () => {
    const h = harness({ users: [account()] });
    await h.caller.emailLogin.request({ email: 'ada@example.com', app: 'oakbox' });
    const { token, code } = h.lastEmail();
    h.attempts[0]!.expiresAt = new Date(Date.now() - 1);

    await expect(h.caller.emailLogin.verifyLink({ token })).rejects.toThrow(LINK_EXPIRED);
    await expect(
      h.caller.emailLogin.verifyCode({ email: 'ada@example.com', code })
    ).rejects.toThrow(CODE_DID_NOT_WORK);
  });

  it('creates the account on first verify, with the email already proven', async () => {
    const onEmailLoginUserCreated = vi.fn(async () => {});
    const h = harness({ hooks: { onEmailLoginUserCreated } });
    await h.caller.emailLogin.request({ email: 'New@Example.com', app: 'oakbox' });
    const { code } = h.lastEmail();

    const result = await h.caller.emailLogin.verifyCode({
      email: 'new@example.com',
      code,
      platform: 'ios',
    });

    expect(result).toMatchObject({ success: true, created: true });
    expect(h.users).toHaveLength(1);
    expect(h.users[0]).toMatchObject({
      email: 'new@example.com',
      emailVerificationStatus: 'VERIFIED',
      password: null,
    });
    expect(onEmailLoginUserCreated).toHaveBeenCalledWith(h.users[0]!.id, {
      email: 'new@example.com',
      app: 'oakbox',
      platform: 'ios',
    });
  });

  it('refuses an existing account whose email was never proven, and creates nothing', async () => {
    // The pre-hijack case: someone registered the victim's address unverified and
    // waits for the victim's first email sign-in.
    const h = harness({ users: [account({ emailVerificationStatus: 'UNVERIFIED' })] });
    await h.caller.emailLogin.request({ email: 'ada@example.com', app: 'oakbox' });
    const { token } = h.lastEmail();

    await expect(h.caller.emailLogin.verifyLink({ token })).rejects.toThrow(
      'Sign in another way, then confirm this email in your account.'
    );
    expect(h.database.session.create).not.toHaveBeenCalled();
    expect(h.database.user.create).not.toHaveBeenCalled();
  });

  it('two verifies creating one account leave one account', async () => {
    let raced = false;
    const h = harness({
      beforeCreate: (data) => {
        // The other racer's insert lands between our lookup and our insert.
        if (raced) return;
        raced = true;
        h.users.push(account({ id: 55, email: data.email, username: 'winner' }));
      },
    });
    await h.caller.emailLogin.request({ email: 'twice@example.com', app: 'oakbox' });
    const { token } = h.lastEmail();

    const result = await h.caller.emailLogin.verifyLink({ token });

    expect(result).toMatchObject({ success: true, created: false, user: { id: 55 } });
    expect(h.users.filter((u) => u.email === 'twice@example.com')).toHaveLength(1);
  });
});

describe('factor-class gate', () => {
  it('email sign-in into a 2FA account returns pendingLogin and spends the attempt', async () => {
    const onDeviceStepRequired = vi.fn(async () => ({ pendingLoginId: 'pending-email' }));
    const h = harness({ users: [withTwoFa()], hooks: { onDeviceStepRequired } });
    await h.caller.emailLogin.request({ email: 'ada@example.com', app: 'oakbox' });
    const { token } = h.lastEmail();

    const result = await h.caller.emailLogin.verifyLink({ token, approvalNonce: 'nonce-1' });

    expect(result).toEqual({
      success: false,
      pendingLogin: true,
      pendingLoginId: 'pending-email',
      userId: 7,
      requires2FA: true,
    });
    expect(onDeviceStepRequired).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        firstFactor: 'EMAIL_LOGIN',
        input: expect.objectContaining({ app: 'oakbox', approvalNonce: 'nonce-1' }),
      })
    );
    expect(h.database.session.create).not.toHaveBeenCalled();
    await expect(h.caller.emailLogin.verifyLink({ token })).rejects.toThrow(LINK_EXPIRED);
  });

  it('without push approval it asks for a code, keeps the link, and signs in with a valid one', async () => {
    const h = harness({ users: [withTwoFa()] });
    await h.caller.emailLogin.request({ email: 'ada@example.com', app: 'oakbox' });
    const { token } = h.lastEmail();

    await expect(h.caller.emailLogin.verifyLink({ token })).resolves.toEqual({
      success: false,
      requires2FA: true,
      userId: 7,
    });
    await expect(
      h.caller.emailLogin.verifyLink({ token, twoFaCode: 'not-a-code' })
    ).rejects.toThrow('Invalid 2FA code.');
    expect(h.database.session.create).not.toHaveBeenCalled();

    await expect(
      h.caller.emailLogin.verifyLink({ token, twoFaCode: BACKUP_CODE })
    ).resolves.toMatchObject({ success: true, user: { id: 7 } });
  });

  it('a magic link into a 2FA account no longer goes straight through', async () => {
    const onDeviceStepRequired = vi.fn(async () => ({ pendingLoginId: 'pending-magic' }));
    const h = harness({ users: [withTwoFa()], hooks: { onDeviceStepRequired } });
    h.magicLinks.push({ id: 'ml-1', userId: 7, usedAt: null, expiresAt: new Date(Date.now() + 60_000) });

    const result = await h.caller.verifyMagicLink({ token: 'ml-1' });

    expect(result).toEqual({
      success: false,
      pendingLogin: true,
      pendingLoginId: 'pending-magic',
      userId: 7,
      requires2FA: true,
    });
    expect(onDeviceStepRequired).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ firstFactor: 'MAGIC_LINK' })
    );
    expect(h.database.session.create).not.toHaveBeenCalled();
  });

  it('a magic link cannot be used twice, even by two requests racing', async () => {
    const h = harness({ users: [account()] });
    h.magicLinks.push({ id: 'ml-2', userId: 7, usedAt: null, expiresAt: new Date(Date.now() + 60_000) });

    const results = await Promise.allSettled([
      h.caller.verifyMagicLink({ token: 'ml-2' }),
      h.caller.verifyMagicLink({ token: 'ml-2' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(h.database.session.create).toHaveBeenCalledTimes(1);
    await expect(h.caller.verifyMagicLink({ token: 'ml-2' })).rejects.toThrow(
      'This link has expired or is invalid'
    );
  });

  it('OAuth into a 2FA account by a linked identity returns pendingLogin, without the token', async () => {
    googleVerify.mockResolvedValue({
      getPayload: () => ({ sub: 'google-sub', email: 'ada@example.com', email_verified: true }),
    });
    const onDeviceStepRequired = vi.fn(async () => ({ pendingLoginId: 'pending-oauth' }));
    const h = harness({ users: [withTwoFa()], linkedUserId: 7, hooks: { onDeviceStepRequired } });

    const result = await h.caller.oAuthLogin({ provider: 'GOOGLE', idToken: 'real-token' });

    expect(result).toEqual({
      success: false,
      pendingLogin: true,
      pendingLoginId: 'pending-oauth',
      userId: 7,
      requires2FA: true,
    });
    const context = onDeviceStepRequired.mock.calls[0]?.[1] as { input: Record<string, unknown> };
    expect(context.input).not.toHaveProperty('idToken');
    expect(h.database.session.create).not.toHaveBeenCalled();
  });

  it('OAuth does not attach a new identity to a 2FA account before the second step', async () => {
    googleVerify.mockResolvedValue({
      getPayload: () => ({ sub: 'new-google-sub', email: 'ada@example.com', email_verified: true }),
    });
    const h = harness({ users: [withTwoFa()] });

    await expect(
      h.caller.oAuthLogin({ provider: 'GOOGLE', idToken: 'real-token' })
    ).resolves.toEqual({ success: false, requires2FA: true, userId: 7 });
    expect(h.oauthAccounts.link).not.toHaveBeenCalled();

    await expect(
      h.caller.oAuthLogin({ provider: 'GOOGLE', idToken: 'real-token', twoFaCode: BACKUP_CODE })
    ).resolves.toMatchObject({ success: true, user: { id: 7 } });
    expect(h.oauthAccounts.link).toHaveBeenCalledTimes(1);
  });

  it('password login keeps returning pendingLogin exactly as before', async () => {
    const onLoginApprovalRequired = vi.fn(async () => ({ pendingLoginId: 'pending-password' }));
    const h = harness({
      users: [withTwoFa({ password: await hashPassword('correct horse battery') })],
      hooks: { onLoginApprovalRequired },
    });

    const result = await h.caller.login({ username: 'ada', password: 'correct horse battery' });

    expect(result).toEqual({
      success: false,
      pendingLogin: true,
      pendingLoginId: 'pending-password',
      userId: 7,
      requires2FA: true,
    });
    expect(onLoginApprovalRequired).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ input: expect.objectContaining({ username: 'ada' }) })
    );
  });

  it('a user-verified passkey stays a DEVICE factor, and the passkey ceremony requires UV', () => {
    const h = harness();
    const user = withTwoFa();
    expect(requiresDeviceStep(h.config, user, 'PASSKEY')).toBe(false);
    for (const factor of ['PASSWORD', 'EMAIL_LOGIN', 'MAGIC_LINK', 'OAUTH'] as const) {
      expect(requiresDeviceStep(h.config, user, factor)).toBe(true);
    }

    // The exemption above is only sound while the ceremony demands user
    // verification at both registration and authentication.
    const source = readFileSync(
      fileURLToPath(new URL('../src/procedures/passkey.ts', import.meta.url)),
      'utf8'
    );
    expect(source.match(/userVerification: 'required'/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(source.match(/requireUserVerification: true/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe('password reset per app', () => {
  it('opens the reset link on the site of the app that asked', async () => {
    const h = harness({ users: [account({ password: 'hashed' })] });

    await h.caller.sendPasswordResetEmail({ email: 'ada@example.com', app: 'oakbox' });
    expect(h.emailService.sendPasswordResetEmail).toHaveBeenLastCalledWith(
      'ada@example.com',
      'reset-1',
      { app: 'oakbox', resetUrl: 'https://oakbox.me/reset-password/reset-1' }
    );

    await h.caller.sendPasswordResetEmail({ email: 'ada@example.com' });
    expect(h.emailService.sendPasswordResetEmail.mock.calls[1]).toEqual(['ada@example.com', 'reset-1']);
  });

  it('refuses an app key the server does not list, before looking up the account', async () => {
    const h = harness({ users: [account({ password: 'hashed' })] });

    await expect(
      h.caller.sendPasswordResetEmail({ email: 'ada@example.com', app: 'nope' })
    ).rejects.toThrow('Unknown app.');
    expect(h.database.user.findByEmailInsensitive).not.toHaveBeenCalled();
  });
});

describe('createAuthConfig with features.emailLogin', () => {
  const valid = () => ({
    database: { emailLoginAttempt: {} },
    secrets: { jwt: 'x' },
    features: { emailLogin: true },
    emailService: { sendLoginEmail: vi.fn() },
    emailLogin: { apps: { oakbox: OAKBOX }, pepper: 'p'.repeat(32), rateLimit: vi.fn() },
  });
  const build = (config: unknown) =>
    createAuthConfig(config as Parameters<typeof createAuthConfig>[0]);

  it('starts when every piece is present', () => {
    expect(() => build(valid())).not.toThrow();
  });

  it('refuses to start without a pepper, a long enough pepper, a rate limiter, a sender, or the attempt store', () => {
    const base = valid();
    expect(() => build({ ...base, emailLogin: { ...base.emailLogin, pepper: undefined } })).toThrow(
      /pepper/
    );
    expect(() => build({ ...base, emailLogin: { ...base.emailLogin, pepper: 'short' } })).toThrow(
      /pepper/
    );
    expect(() => build({ ...base, emailLogin: { ...base.emailLogin, rateLimit: undefined } })).toThrow(
      /rateLimit/
    );
    expect(() => build({ ...base, emailService: undefined })).toThrow(/sendLoginEmail/);
    expect(() => build({ ...base, database: {} })).toThrow(/emailLoginAttempt/);
    expect(() => build({ ...base, emailLogin: { ...base.emailLogin, apps: {} } })).toThrow(/apps/);
  });

  it('asks for none of it while the feature is off', () => {
    expect(() =>
      build({ database: {}, secrets: { jwt: 'x' }, features: { emailLogin: false } })
    ).not.toThrow();
  });
});

describe('security review fixes', () => {
  /** A lookup that behaves like an unescaped ILIKE: `_` is any one character. */
  const ilikeLookup = (h: ReturnType<typeof harness>) =>
    h.database.user.findByEmailInsensitive.mockImplementation(async (pattern: string) => {
      const source = pattern
        .split('')
        .map((char) => (char === '_' ? '.' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('');
      const re = new RegExp(`^${source}$`, 'i');
      return h.users.find((u) => u.email !== null && re.test(u.email)) ?? null;
    });
  const john = () => account({ id: 9, email: 'john@outlook.com', username: 'john' });

  it('a look-alike address never signs into the account a wildcard lookup matched', async () => {
    const h = harness({ users: [john()] });
    ilikeLookup(h);

    await h.caller.emailLogin.request({ email: 'j_hn@outlook.com', app: 'oakbox' });
    const { code } = h.lastEmail();
    const result = await h.caller.emailLogin.verifyCode({ email: 'j_hn@outlook.com', code });

    expect(result).toMatchObject({ success: true, created: true });
    const lookAlike = h.users.find((u) => u.email === 'j_hn@outlook.com');
    expect(lookAlike).toBeDefined();
    expect(h.database.session.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: lookAlike!.id })
    );
    expect(h.database.session.create).not.toHaveBeenCalledWith(expect.objectContaining({ userId: 9 }));
  });

  it('OAuth does not attach a look-alike address to the account a wildcard lookup matched', async () => {
    googleVerify.mockResolvedValue({
      getPayload: () => ({ sub: 'attacker-sub', email: 'j_hn@outlook.com', email_verified: true }),
    });
    const h = harness({ users: [john()] });
    ilikeLookup(h);

    await h.caller.oAuthLogin({ provider: 'GOOGLE', idToken: 'attacker-token' });

    expect(h.oauthAccounts.link).not.toHaveBeenCalledWith(9, expect.anything());
  });

  it('a password reset for a look-alike address goes nowhere', async () => {
    const h = harness({ users: [account({ id: 9, email: 'john@outlook.com', password: 'hashed' })] });
    ilikeLookup(h);

    await h.caller.sendPasswordResetEmail({ email: 'j_hn@outlook.com' });

    expect(h.emailService.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('five wrong second-step codes spend the email attempt', async () => {
    const h = harness({ users: [withTwoFa()] });
    await h.caller.emailLogin.request({ email: 'ada@example.com', app: 'oakbox' });
    const { token } = h.lastEmail();

    await expect(h.caller.emailLogin.verifyLink({ token })).resolves.toMatchObject({
      requires2FA: true,
    });
    for (let i = 0; i < 5; i += 1) {
      await expect(
        h.caller.emailLogin.verifyLink({ token, twoFaCode: 'wrong-code' })
      ).rejects.toThrow('Invalid 2FA code.');
    }
    await expect(
      h.caller.emailLogin.verifyLink({ token, twoFaCode: BACKUP_CODE })
    ).rejects.toThrow(LINK_EXPIRED);
    expect(h.database.session.create).not.toHaveBeenCalled();
  });

  it('five wrong second-step codes spend a magic link', async () => {
    const h = harness({ users: [withTwoFa()] });
    h.magicLinks.push({ id: 'ml-guess', userId: 7, usedAt: null, expiresAt: new Date(Date.now() + 60_000) });

    for (let i = 0; i < 5; i += 1) {
      await expect(
        h.caller.verifyMagicLink({ token: 'ml-guess', twoFaCode: 'wrong-code' })
      ).rejects.toThrow('Invalid 2FA code.');
    }
    await expect(
      h.caller.verifyMagicLink({ token: 'ml-guess', twoFaCode: BACKUP_CODE })
    ).rejects.toThrow('This link has expired or is invalid');
    expect(h.database.session.create).not.toHaveBeenCalled();
  });

  it('caps second-step codes for one account across credentials and IPs', async () => {
    const h = harness({ users: [withTwoFa()] });
    for (let i = 0; i < 10; i += 1) {
      h.magicLinks.push({ id: `ml-cap-${i}`, userId: 7, usedAt: null, expiresAt: new Date(Date.now() + 60_000) });
      await expect(
        h.callerAt(`198.51.100.${i}`).verifyMagicLink({ token: `ml-cap-${i}`, twoFaCode: 'wrong-code' })
      ).rejects.toThrow('Invalid 2FA code.');
    }
    h.magicLinks.push({ id: 'ml-cap-last', userId: 7, usedAt: null, expiresAt: new Date(Date.now() + 60_000) });
    await expect(
      h.callerAt('198.51.100.99').verifyMagicLink({ token: 'ml-cap-last', twoFaCode: BACKUP_CODE })
    ).rejects.toThrow('Too many tries.');
  });

  it('two requests racing on one link push the device once', async () => {
    const onDeviceStepRequired = vi.fn(async () => ({ pendingLoginId: 'pending-once' }));
    const h = harness({ users: [withTwoFa()], hooks: { onDeviceStepRequired } });
    await h.caller.emailLogin.request({ email: 'ada@example.com', app: 'oakbox' });
    const { token } = h.lastEmail();

    await Promise.allSettled([
      h.caller.emailLogin.verifyLink({ token }),
      h.caller.emailLogin.verifyLink({ token }),
    ]);

    expect(onDeviceStepRequired).toHaveBeenCalledTimes(1);
  });

  it('every mint site runs beforeSessionMint, and a refusal stops before any push or session', async () => {
    const beforeSessionMint = vi.fn(async () => {
      throw new Error('Your account has been deleted.');
    });
    const onDeviceStepRequired = vi.fn(async () => ({ pendingLoginId: 'never' }));
    const h = harness({
      users: [withTwoFa({ password: await hashPassword('correct horse battery') })],
      hooks: { beforeSessionMint, onDeviceStepRequired },
      linkedUserId: 7,
    });
    googleVerify.mockResolvedValue({
      getPayload: () => ({ sub: 'google-sub', email: 'ada@example.com', email_verified: true }),
    });
    h.magicLinks.push({ id: 'ml-deleted', userId: 7, usedAt: null, expiresAt: new Date(Date.now() + 60_000) });

    await h.caller.emailLogin.request({ email: 'ada@example.com', app: 'oakbox' });
    await expect(h.caller.emailLogin.verifyLink({ token: h.lastEmail().token })).rejects.toThrow(
      'deleted'
    );
    await expect(h.caller.verifyMagicLink({ token: 'ml-deleted' })).rejects.toThrow('deleted');
    await expect(h.caller.oAuthLogin({ provider: 'GOOGLE', idToken: 'real-token' })).rejects.toThrow(
      'deleted'
    );
    await expect(
      h.caller.login({ username: 'ada', password: 'correct horse battery' })
    ).rejects.toThrow('deleted');

    expect(beforeSessionMint.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      expect.objectContaining({ firstFactor: 'EMAIL_LOGIN' }),
      expect.objectContaining({ firstFactor: 'MAGIC_LINK' }),
      expect.objectContaining({ firstFactor: 'OAUTH' }),
      expect.objectContaining({ firstFactor: 'PASSWORD' }),
    ]);
    expect(onDeviceStepRequired).not.toHaveBeenCalled();
    expect(h.database.session.create).not.toHaveBeenCalled();
  });

  it('a magic link refuses a banned account', async () => {
    const h = harness({ users: [account({ status: 'BANNED' })] });
    h.magicLinks.push({ id: 'ml-banned', userId: 7, usedAt: null, expiresAt: new Date(Date.now() + 60_000) });

    await expect(h.caller.verifyMagicLink({ token: 'ml-banned' })).rejects.toThrow('banned');
    expect(h.database.session.create).not.toHaveBeenCalled();
  });

  it('a provisioning failure is not hidden behind the create-race recovery', async () => {
    const onEmailLoginUserCreated = vi.fn(async () => {
      throw new Error('provisioning failed');
    });
    const h = harness({ hooks: { onEmailLoginUserCreated } });
    await h.caller.emailLogin.request({ email: 'new@example.com', app: 'oakbox' });
    const { code } = h.lastEmail();

    await expect(
      h.caller.emailLogin.verifyCode({ email: 'new@example.com', code })
    ).rejects.toThrow('provisioning failed');
    expect(h.database.session.create).not.toHaveBeenCalled();
  });

  it('a failed send still answers { sent: true }', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = harness();
      h.emailService.sendLoginEmail.mockRejectedValueOnce(
        new Error('MessageRejected: the address is on the suppression list')
      );

      await expect(
        h.caller.emailLogin.request({ email: 'bounces@example.com', app: 'oakbox' })
      ).resolves.toEqual({ sent: true });
    } finally {
      quiet.mockRestore();
    }
  });

  it('a key inherited from Object is not an app', async () => {
    const h = harness({ users: [account({ password: 'hashed' })] });

    await expect(
      h.caller.emailLogin.request({ email: 'ada@example.com', app: 'constructor' })
    ).rejects.toThrow('Unknown app.');
    await expect(
      h.caller.sendPasswordResetEmail({ email: 'ada@example.com', app: 'constructor' })
    ).rejects.toThrow('Unknown app.');
    expect(h.sent).toHaveLength(0);
  });

  it("a stranger's requests from one IP cannot use up the owner's", async () => {
    const h = harness({ users: [account()] });
    const stranger = h.callerAt('198.51.100.1');

    for (let i = 0; i < 4; i += 1) {
      await stranger.emailLogin.request({ email: 'ada@example.com', app: 'oakbox' });
    }
    expect(h.sent).toHaveLength(3);

    await h.caller.emailLogin.request({ email: 'ada@example.com', app: 'oakbox' });
    expect(h.sent).toHaveLength(4);
  });
});
