import { initTRPC } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OAuthLoginProcedureFactory } from '../src/procedures/oauth';
import type { AuthProcedure, BaseProcedure, TrpcContext } from '../src/types/trpc';
import { createAuthConfig } from '../src/utilities/config';
import { oAuthLoginSchema } from '../src/validators';

/**
 * `oAuthLogin` attaches a NEW OAuth identity to an existing passwordless account
 * whose email matches the provider's. That used to happen whether or not the
 * account's email had ever been proven. A consumer that lets users store any
 * unclaimed address unverified (factiii's profile update does) is then open to
 * account pre-hijacking: register a passwordless account under a victim's
 * address, wait for the victim's first genuine Google sign-in, and watch it land
 * in an account the attacker still holds a passkey for.
 *
 * The attacker needs nothing forged here — the victim's token is real and
 * verified. The only defence is refusing to attach to an unproven address.
 *
 * The in-memory adapter returns FULL user rows, the way the real Prisma
 * (`findFirst`, no select) and Drizzle (`.select()`, no args) adapters do. A mock
 * that dropped `emailVerificationStatus` would make the new check refuse every
 * attach and hide the lockout regression this file exists to catch.
 */

const { googleVerify } = vi.hoisted(() => ({ googleVerify: vi.fn() }));

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    verifyIdToken = googleVerify;
  },
}));

// Imported by the verifier; never exercised here, but mocked so no test depends
// on the real library's network or key handling.
vi.mock('apple-signin-auth', () => ({ default: { verifyIdToken: vi.fn() } }));

const KEYS = { google: { clientId: 'google-client' } };

type UserRow = {
  id: number;
  email: string;
  username: string;
  password: string | null;
  status: string;
  emailVerificationStatus?: string;
  updatedAt: Date;
  verifiedHumanAt: Date | null;
};

const account = (overrides: Partial<UserRow>): UserRow => ({
  id: 7,
  email: 'victim@gmail.com',
  username: 'someone',
  password: null,
  status: 'ACTIVE',
  emailVerificationStatus: 'VERIFIED',
  updatedAt: new Date('2026-01-01'),
  verifiedHumanAt: null,
  ...overrides,
});

// The victim's own, genuine Google sign-in: a real subject and an email Google
// has verified. Nothing about this token is forged.
const genuineGoogleToken = () =>
  googleVerify.mockResolvedValue({
    getPayload: () => ({
      sub: 'victims-own-google-sub',
      email: 'victim@gmail.com',
      email_verified: true,
    }),
  });

function buildCaller(opts: { user: UserRow; linkedUserId?: number }) {
  const oauthAccounts = {
    resolve: vi.fn(async () => (opts.linkedUserId ? { userId: opts.linkedUserId } : null)),
    link: vi.fn(async () => {}),
    list: vi.fn(async () => []),
    unlink: vi.fn(async () => {}),
  };
  const database = {
    user: {
      findActiveById: vi.fn(async (id: number) => (id === opts.user.id ? opts.user : null)),
      findByEmailInsensitive: vi.fn(async (email: string) =>
        email.toLowerCase() === opts.user.email.toLowerCase() ? opts.user : null
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
    features: { twoFa: false, oauth: { google: true } },
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

beforeEach(() => {
  googleVerify.mockReset();
});

describe('oAuthLogin attach-by-email', () => {
  it('refuses to pre-hijack: a genuine Google sign-in never lands in an account registered under the unverified address', async () => {
    genuineGoogleToken();
    const { caller, oauthAccounts, database } = buildCaller({
      user: account({ emailVerificationStatus: 'UNVERIFIED' }),
    });

    await expect(
      caller.oAuthLogin({ provider: 'GOOGLE', idToken: 'victims-real-token' })
    ).rejects.toThrow('Sign in another way, then link this provider from Settings.');

    expect(oauthAccounts.link).not.toHaveBeenCalled();
    expect(database.session.create).not.toHaveBeenCalled();
  });

  it('still attaches and signs in when the matching account proved its email', async () => {
    // The lockout regression. If the verification check were wrong — or the
    // adapter did not return the field — this real user would be refused.
    genuineGoogleToken();
    const { caller, oauthAccounts, database } = buildCaller({ user: account({}) });

    const result = await caller.oAuthLogin({ provider: 'GOOGLE', idToken: 'real-token' });

    expect(result).toMatchObject({ success: true, user: { id: 7 } });
    expect(oauthAccounts.link).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ provider: 'GOOGLE', subject: 'victims-own-google-sub' })
    );
    expect(database.session.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 7 }));
  });

  it('leaves an already-linked user alone: resolved by sub, no attach, whatever the email status', async () => {
    // The check guards attaching a NEW identity only. A user already linked is
    // found in step 1 and never reaches it.
    genuineGoogleToken();
    const { caller, oauthAccounts, database } = buildCaller({
      user: account({ emailVerificationStatus: 'UNVERIFIED' }),
      linkedUserId: 7,
    });

    const result = await caller.oAuthLogin({ provider: 'GOOGLE', idToken: 'real-token' });

    expect(result).toMatchObject({ success: true, user: { id: 7 } });
    expect(oauthAccounts.link).not.toHaveBeenCalled();
    expect(database.session.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 7 }));
  });

  it('still refuses a password account with the original message, before the new check', async () => {
    // UNVERIFIED on purpose: the password refusal must still win, word for word,
    // because consumers assert that exact text.
    genuineGoogleToken();
    const { caller, oauthAccounts } = buildCaller({
      user: account({ password: 'hashed', emailVerificationStatus: 'UNVERIFIED' }),
    });

    await expect(
      caller.oAuthLogin({ provider: 'GOOGLE', idToken: 'real-token' })
    ).rejects.toThrow('This email uses password login. Please use email/password.');

    expect(oauthAccounts.link).not.toHaveBeenCalled();
  });

  it('fails closed when an adapter does not return the verification status', async () => {
    genuineGoogleToken();
    const { caller, oauthAccounts } = buildCaller({
      user: account({ emailVerificationStatus: undefined }),
    });

    await expect(
      caller.oAuthLogin({ provider: 'GOOGLE', idToken: 'real-token' })
    ).rejects.toThrow('Sign in another way, then link this provider from Settings.');

    expect(oauthAccounts.link).not.toHaveBeenCalled();
  });
});
