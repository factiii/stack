import { initTRPC } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPrismaAdapter } from '../src/adapters/prismaAdapter';
import { BaseProcedureFactory } from '../src/procedures/base';
import { OAuthLoginProcedureFactory } from '../src/procedures/oauth';
import type { AuthProcedure, BaseProcedure, TrpcContext } from '../src/types/trpc';
import { createAuthConfig } from '../src/utilities/config';
import { escapeLikePattern, sameIdentifier } from '../src/utilities/emailMatch';
import { oAuthLoginSchema } from '../src/validators';

/**
 * Case-insensitive lookups compile to ILIKE on Postgres, where `_` and `%` are
 * pattern characters. The package tests have no Postgres, so the adapter tests
 * fake a database that answers the way an unescaped ILIKE would — it returns the
 * stored row for a look-alike value — and assert both the escaped argument and
 * that the adapter drops the look-alike row. The procedure tests fake an adapter
 * that still misbehaves, to prove the callers' own re-check holds on its own.
 */

const { googleVerify } = vi.hoisted(() => ({ googleVerify: vi.fn() }));

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    verifyIdToken = googleVerify;
  },
}));

vi.mock('apple-signin-auth', () => ({ default: { verifyIdToken: vi.fn() } }));

const STORED = {
  id: 7,
  email: 'john@outlook.com',
  username: 'john',
  password: null as string | null,
  status: 'ACTIVE',
  emailVerificationStatus: 'VERIFIED',
  updatedAt: new Date('2026-01-01'),
  verifiedHumanAt: null,
};

const ctx = {
  headers: { 'user-agent': 'Mozilla/5.0' },
  res: { setHeader: vi.fn() },
  userId: null,
  sessionId: null,
  socketId: null,
  ip: '127.0.0.1',
} as unknown as TrpcContext;

beforeEach(() => {
  googleVerify.mockReset();
});

describe('escapeLikePattern', () => {
  it('escapes backslash, percent and underscore', () => {
    expect(escapeLikePattern('j_hn%x\\y@outlook.com')).toBe('j\\_hn\\%x\\\\y@outlook.com');
  });

  it('leaves an ordinary address unchanged', () => {
    expect(escapeLikePattern('John.Smith+tag@Outlook.com')).toBe('John.Smith+tag@Outlook.com');
  });
});

describe('sameIdentifier', () => {
  it('matches when only case differs', () => {
    expect(sameIdentifier('john@outlook.com', 'JOHN@Outlook.com')).toBe(true);
  });

  it('does not match a look-alike or a missing value', () => {
    expect(sameIdentifier('john@outlook.com', 'j_hn@outlook.com')).toBe(false);
    expect(sameIdentifier(null, 'john@outlook.com')).toBe(false);
  });
});

describe('Prisma adapter case-insensitive lookups', () => {
  // Answers every lookup with the stored row, the way an unescaped ILIKE answers
  // a pattern that fits it.
  const wildcardPrisma = () => {
    const findFirst = vi.fn(async () => ({ ...STORED }));
    return { findFirst, adapter: createPrismaAdapter({ user: { findFirst } }) };
  };

  it('escapes the email and drops a row whose address differs', async () => {
    const { findFirst, adapter } = wildcardPrisma();

    await expect(adapter.user.findByEmailInsensitive('j_hn@outlook.com')).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalledWith({
      where: { email: { equals: 'j\\_hn@outlook.com', mode: 'insensitive' } },
    });
  });

  it('escapes the username and drops a row whose username differs', async () => {
    const { findFirst, adapter } = wildcardPrisma();

    await expect(adapter.user.findByUsernameInsensitive('jo%')).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalledWith({
      where: { username: { equals: 'jo\\%', mode: 'insensitive' } },
    });
  });

  it('escapes both branches of the identifier lookup and drops a look-alike', async () => {
    const { findFirst, adapter } = wildcardPrisma();

    await expect(adapter.user.findByEmailOrUsernameInsensitive('j_hn')).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { email: { equals: 'j\\_hn', mode: 'insensitive' } },
          { username: { equals: 'j\\_hn', mode: 'insensitive' } },
        ],
      },
    });
  });

  it('still finds a stored address typed in different case', async () => {
    const { adapter } = wildcardPrisma();

    await expect(adapter.user.findByEmailInsensitive('JOHN@Outlook.com')).resolves.toMatchObject({
      id: 7,
    });
    await expect(adapter.user.findByEmailOrUsernameInsensitive('John')).resolves.toMatchObject({
      id: 7,
    });
  });
});

describe('callers re-check the lookup result', () => {
  it('OAuth never attaches a look-alike address to the stored account', async () => {
    googleVerify.mockResolvedValue({
      getPayload: () => ({ sub: 'look-alike-sub', email: 'j_hn@outlook.com', email_verified: true }),
    });
    const oauthAccounts = {
      resolve: vi.fn(async () => null),
      link: vi.fn(async () => {}),
      list: vi.fn(async () => []),
      unlink: vi.fn(async () => {}),
    };
    const database = {
      user: {
        findActiveById: vi.fn(async () => null),
        // A misbehaving adapter: returns the stored account for the look-alike.
        findByEmailInsensitive: vi.fn(async () => ({ ...STORED })),
        create: vi.fn(async (data: { email: string; username: string }) => ({
          ...STORED,
          id: 8,
          email: data.email,
          username: data.username,
        })),
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
      oauthKeys: { google: { clientId: 'google-client' } },
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

    await t.createCallerFactory(router)(ctx).oAuthLogin({ provider: 'GOOGLE', idToken: 'token' });

    expect(database.user.create).toHaveBeenCalledOnce();
    expect(oauthAccounts.link).toHaveBeenCalledWith(8, expect.anything());
    expect(oauthAccounts.link).not.toHaveBeenCalledWith(7, expect.anything());
  });

  it('a password reset for a look-alike address sends nothing to the stored account', async () => {
    const sendPasswordResetEmail = vi.fn(async () => {});
    const passwordReset = {
      deleteAllByUserId: vi.fn(async () => {}),
      create: vi.fn(async () => ({ id: 'reset-1' })),
    };
    const database = {
      user: {
        // A misbehaving adapter: returns the stored account for the look-alike.
        findByEmailInsensitive: vi.fn(async () => ({ ...STORED, password: 'hash' })),
      },
      passwordReset,
    };
    const config = createAuthConfig({
      database,
      secrets: { jwt: 'test-secret-key' },
      features: { twoFa: false },
      emailService: {
        sendPasswordResetEmail,
        sendVerificationEmail: vi.fn(async () => {}),
        sendOTPEmail: vi.fn(async () => {}),
      },
    } as unknown as Parameters<typeof createAuthConfig>[0]);
    const t = initTRPC.context<TrpcContext>().create();
    const factory = new BaseProcedureFactory(
      config,
      t.procedure as unknown as BaseProcedure,
      t.procedure as unknown as AuthProcedure
    );
    // Only the reset procedure is under test, so it is built on its own.
    const buildReset = (
      factory as unknown as { sendPasswordResetEmail(): ReturnType<typeof t.procedure.mutation> }
    ).sendPasswordResetEmail.bind(factory);
    const router = t.router({ sendPasswordResetEmail: buildReset() });

    const result = await t
      .createCallerFactory(router)(ctx)
      .sendPasswordResetEmail({ email: 'j_hn@outlook.com' });

    expect(result).toEqual({
      message: 'If an account exists with that email, a reset link has been sent.',
    });
    expect(passwordReset.create).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });
});
