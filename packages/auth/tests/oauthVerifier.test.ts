import { initTRPC } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OAuthLoginProcedureFactory } from '../src/procedures/oauth';
import type { AuthProcedure, BaseProcedure, TrpcContext } from '../src/types/trpc';
import { createAuthConfig } from '../src/utilities/config';
import { createOAuthVerifier } from '../src/utilities/oauth';
import { oAuthLoginSchema } from '../src/validators';

/**
 * Apple sign-in used to take the account email from the CLIENT whenever Apple's
 * signed token carried no email claim (`finalEmail = email || extra?.email`).
 * `oAuthLogin` attaches a new identity to any existing passwordless account with
 * a matching email, so anyone holding a valid Apple token for their OWN Apple ID
 * could name a victim's address and be signed into the victim's account. Google
 * had the same shape one step removed: it trusted `payload.email` without
 * checking `email_verified`.
 *
 * The mocks below can hand back an email-less Apple token and an unverified
 * Google email — the dangerous inputs. A mock that can only produce well-formed
 * tokens is how a bug like this passes a green suite.
 */

const { appleVerify, googleVerify } = vi.hoisted(() => ({
  appleVerify: vi.fn(),
  googleVerify: vi.fn(),
}));

vi.mock('apple-signin-auth', () => ({
  default: { verifyIdToken: appleVerify },
}));

// A real class, not `vi.fn(() => ({}))`: the verifier calls `new OAuth2Client()`.
vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    verifyIdToken = googleVerify;
  },
}));

const KEYS = { apple: { clientId: 'apple-client' }, google: { clientId: 'google-client' } };

const googleToken = (payload: Record<string, unknown>) => ({ getPayload: () => payload });

beforeEach(() => {
  appleVerify.mockReset();
  googleVerify.mockReset();
});

describe('createOAuthVerifier: Apple', () => {
  const verify = createOAuthVerifier(KEYS);

  it('never lets a client-supplied email stand in for a missing token email', async () => {
    appleVerify.mockResolvedValue({ sub: 'attacker-apple-sub' });

    const result = await verify('APPLE', 'token', { email: 'victim@example.com' });

    expect(result.email).not.toBe('victim@example.com');
    expect(result.email).toBeUndefined();
    expect(result.oauthId).toBe('attacker-apple-sub');
  });

  it('returns the signed token email and ignores whatever the client sent', async () => {
    appleVerify.mockResolvedValue({ sub: 'apple-sub', email: 'real@icloud.com' });

    const result = await verify('APPLE', 'token', { email: 'victim@example.com' });

    expect(result).toEqual({ oauthId: 'apple-sub', email: 'real@icloud.com' });
  });

  it('does not throw when the token has no email, so a linked user is not locked out', async () => {
    appleVerify.mockResolvedValue({ sub: 'apple-sub' });

    await expect(verify('APPLE', 'token')).resolves.toEqual({
      oauthId: 'apple-sub',
      email: undefined,
    });
  });

  it('still refuses a token with no subject', async () => {
    appleVerify.mockResolvedValue({ email: 'real@icloud.com' });

    await expect(verify('APPLE', 'token')).rejects.toThrow('Invalid Apple token');
  });
});

describe('createOAuthVerifier: Google', () => {
  const verify = createOAuthVerifier(KEYS);

  it('does not trust an email Google marks unverified', async () => {
    googleVerify.mockResolvedValue(
      googleToken({ sub: 'google-sub', email: 'victim@example.com', email_verified: false })
    );

    const result = await verify('GOOGLE', 'token');

    expect(result.email).toBeUndefined();
    expect(result.oauthId).toBe('google-sub');
  });

  it('does not trust an email when the verified flag is missing', async () => {
    // Absent is not "true". Only an explicit verification counts.
    googleVerify.mockResolvedValue(googleToken({ sub: 'google-sub', email: 'victim@example.com' }));

    expect((await verify('GOOGLE', 'token')).email).toBeUndefined();
  });

  it('returns a verified email', async () => {
    googleVerify.mockResolvedValue(
      googleToken({ sub: 'google-sub', email: 'real@gmail.com', email_verified: true })
    );

    expect(await verify('GOOGLE', 'token')).toEqual({
      oauthId: 'google-sub',
      email: 'real@gmail.com',
    });
  });

  it('still refuses a token with no subject', async () => {
    googleVerify.mockResolvedValue(googleToken({ email: 'real@gmail.com', email_verified: true }));

    await expect(verify('GOOGLE', 'token')).rejects.toThrow('Invalid Google token');
  });
});

/**
 * The verifier tests prove what the verifier returns. These prove what that means
 * at sign-in, through the real `oAuthLogin` procedure: the attack is refused, and
 * the fix does not lock out the linked users it could most easily break.
 */
describe('oAuthLogin with the fixed verifier', () => {
  const VICTIM = {
    id: 7,
    email: 'victim@example.com',
    username: 'victim',
    password: null,
    status: 'ACTIVE',
    updatedAt: new Date('2026-01-01'),
    verifiedHumanAt: null,
  };

  function buildCaller(opts: { linkedUserId?: number }) {
    const oauthAccounts = {
      resolve: vi.fn(async () => (opts.linkedUserId ? { userId: opts.linkedUserId } : null)),
      link: vi.fn(async () => {}),
      list: vi.fn(async () => []),
      unlink: vi.fn(async () => {}),
    };
    const database = {
      user: {
        findActiveById: vi.fn(async (id: number) => (id === VICTIM.id ? VICTIM : null)),
        // The victim is passwordless: exactly the account attach-by-email targets.
        findByEmailInsensitive: vi.fn(async (email: string) =>
          email.toLowerCase() === VICTIM.email ? VICTIM : null
        ),
        create: vi.fn(),
      },
      session: {
        create: vi.fn(async (data: { userId: number }) => ({ id: 99, userId: data.userId })),
        findManyByIds: vi.fn(async () => []),
      },
    };

    const config = createAuthConfig({
      database,
      secrets: { jwt: 'test-secret-key' },
      features: { twoFa: false, oauth: { apple: true, google: true } },
      oauthKeys: KEYS,
      oauthAccounts,
    } as unknown as Parameters<typeof createAuthConfig>[0]);

    const t = initTRPC.context<TrpcContext>().create();
    const factory = new OAuthLoginProcedureFactory(
      config,
      t.procedure as unknown as BaseProcedure,
      t.procedure as unknown as AuthProcedure
    );
    const router = t.router(
      factory.createOAuthLoginProcedures({ oauth: oAuthLoginSchema } as unknown as Parameters<
        typeof factory.createOAuthLoginProcedures
      >[0])
    );
    const ctx = {
      headers: { 'user-agent': 'Mozilla/5.0' },
      res: { setHeader: vi.fn() },
      userId: null,
      sessionId: null,
      socketId: null,
      ip: '127.0.0.1',
    } as unknown as TrpcContext;

    return { caller: t.createCallerFactory(router)(ctx), oauthAccounts, database };
  }

  it('refuses an Apple token that names a victim email, and attaches nothing', async () => {
    appleVerify.mockResolvedValue({ sub: 'attacker-apple-sub' });
    const { caller, oauthAccounts, database } = buildCaller({});

    await expect(
      caller.oAuthLogin({
        provider: 'APPLE',
        idToken: 'attacker-token',
        user: { email: VICTIM.email },
      })
    ).rejects.toThrow('Email not provided by OAuth provider');

    expect(oauthAccounts.link).not.toHaveBeenCalled();
    expect(database.session.create).not.toHaveBeenCalled();
  });

  it('refuses a Google token whose email is unverified, and attaches nothing', async () => {
    googleVerify.mockResolvedValue(
      googleToken({ sub: 'attacker-google-sub', email: VICTIM.email, email_verified: false })
    );
    const { caller, oauthAccounts, database } = buildCaller({});

    await expect(
      caller.oAuthLogin({ provider: 'GOOGLE', idToken: 'attacker-token' })
    ).rejects.toThrow('Email not provided by OAuth provider');

    expect(oauthAccounts.link).not.toHaveBeenCalled();
    expect(database.session.create).not.toHaveBeenCalled();
  });

  it('still signs in a linked Apple user whose token has no email, through sub', async () => {
    // The regression this fix could most easily cause. The old verifier threw on
    // a missing email before `oAuthLogin` could resolve the user by `sub`.
    appleVerify.mockResolvedValue({ sub: 'victims-own-apple-sub' });
    const { caller, database } = buildCaller({ linkedUserId: VICTIM.id });

    const result = await caller.oAuthLogin({ provider: 'APPLE', idToken: 'real-token' });

    expect(result).toMatchObject({ success: true, user: { id: VICTIM.id } });
    expect(database.session.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: VICTIM.id })
    );
  });
});
