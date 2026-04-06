import { describe, it, expect, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import { createAuthGuard } from '../src/middleware/authGuard';
import { createAuthToken } from '../src/utilities/jwt';
import type { SessionWithUser } from '../src/adapters/database';
import type { AuthConfig } from '../src/types/config';

const SECRET = 'test-secret-key';

/**
 * The auth guard is tRPC middleware. To unit-test it we capture the
 * middleware function via a fake tRPC builder, then invoke it directly
 * with a mock context/meta/next.
 */
function buildGuard(sessionLookup: (id: number) => Promise<SessionWithUser | null>) {
  let middlewareFn: (opts: Record<string, unknown>) => Promise<unknown>;

  const fakeT = {
    middleware: (fn: typeof middlewareFn) => {
      middlewareFn = fn;
      return fn;
    },
  };

  const config: AuthConfig = {
    database: {
      user: {} as AuthConfig['database'] extends undefined ? never : any,
      session: {
        findById: sessionLookup,
        create: vi.fn(),
        update: vi.fn(),
        updateLastUsed: vi.fn(),
        revoke: vi.fn(),
        findActiveByUserId: vi.fn(),
        revokeAllByUserId: vi.fn(),
        findTwoFaSecretsByUserId: vi.fn(),
        clearTwoFaSecrets: vi.fn(),
        findByIdWithDevice: vi.fn(),
        revokeByDevicePushToken: vi.fn(),
        clearDeviceId: vi.fn(),
      },
      otp: { findValidByUserAndCode: vi.fn(), create: vi.fn(), delete: vi.fn() },
      passwordReset: { findById: vi.fn(), create: vi.fn(), delete: vi.fn(), deleteAllByUserId: vi.fn() },
      device: {
        findByTokenSessionAndUser: vi.fn(),
        upsertByPushToken: vi.fn(),
        findByUserAndToken: vi.fn(),
        disconnectUser: vi.fn(),
        hasRemainingUsers: vi.fn(),
        delete: vi.fn(),
      },
      admin: { findByUserId: vi.fn() },
    },
    secrets: { jwt: SECRET },
  };

  createAuthGuard(config as AuthConfig, fakeT as any);

  return middlewareFn!;
}

function makeCtx(token?: string) {
  const headers: Record<string, string | undefined> = {
    'user-agent': 'vitest',
    cookie: token ? `auth-token=${token}` : '',
    origin: 'http://localhost:3000',
  };
  return {
    userId: null,
    sessionId: null,
    socketId: null,
    ip: '127.0.0.1',
    headers,
    res: {
      req: { headers },
      setHeader: vi.fn(),
      getHeader: vi.fn(),
      appendHeader: vi.fn(),
    },
  };
}

function makeSession(overrides: Partial<SessionWithUser> & { userId: number; issuedAt: Date }): SessionWithUser {
  return {
    id: 1,
    socketId: null,
    twoFaSecret: null,
    browserName: 'vitest',
    lastUsed: new Date(),
    revokedAt: null,
    deviceId: null,
    user: { status: 'ACTIVE', verifiedHumanAt: null, updatedAt: new Date() },
    ...overrides,
  };
}

describe('authGuard session integrity checks', () => {
  it('rejects token when JWT userId does not match session userId', async () => {
    const token = createAuthToken(
      { id: 1, userId: 5, verifiedHumanAt: null },
      { secret: SECRET, expiresIn: 3600 },
    );

    // Session id=1 exists but belongs to userId=99 (different user)
    const guard = buildGuard(async () =>
      makeSession({ id: 1, userId: 99, issuedAt: new Date() }),
    );

    const ctx = makeCtx(token);
    const next = vi.fn();

    await expect(
      guard({ ctx, meta: { authRequired: true }, next, path: 'test.route' }),
    ).rejects.toThrow(TRPCError);

    expect(next).not.toHaveBeenCalled();
  });

  it('allows token when JWT userId matches session userId', async () => {
    const now = new Date();
    const token = createAuthToken(
      { id: 1, userId: 5, verifiedHumanAt: null },
      { secret: SECRET, expiresIn: 3600 },
    );

    const guard = buildGuard(async () =>
      makeSession({ id: 1, userId: 5, issuedAt: now }),
    );

    const ctx = makeCtx(token);
    const next = vi.fn(({ ctx: newCtx }) => ({ ctx: newCtx }));

    await guard({ ctx, meta: { authRequired: true }, next, path: 'test.route' });

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({ userId: 5 }),
      }),
    );
  });

  it('rejects token when iat predates session issuedAt', async () => {
    // Create token with iat = now
    const token = createAuthToken(
      { id: 1, userId: 5, verifiedHumanAt: null },
      { secret: SECRET, expiresIn: 3600 },
    );

    // Session was created 1 hour in the future relative to the token
    const futureDate = new Date(Date.now() + 60 * 60 * 1000);

    const guard = buildGuard(async () =>
      makeSession({ id: 1, userId: 5, issuedAt: futureDate }),
    );

    const ctx = makeCtx(token);
    const next = vi.fn();

    await expect(
      guard({ ctx, meta: { authRequired: true }, next, path: 'test.route' }),
    ).rejects.toThrow(TRPCError);

    expect(next).not.toHaveBeenCalled();
  });

  it('allows token when iat equals or is after session issuedAt', async () => {
    // Session created slightly before the token (normal flow)
    const sessionCreated = new Date(Date.now() - 1000);

    const token = createAuthToken(
      { id: 1, userId: 5, verifiedHumanAt: null },
      { secret: SECRET, expiresIn: 3600 },
    );

    const guard = buildGuard(async () =>
      makeSession({ id: 1, userId: 5, issuedAt: sessionCreated }),
    );

    const ctx = makeCtx(token);
    const next = vi.fn(({ ctx: newCtx }) => ({ ctx: newCtx }));

    await guard({ ctx, meta: { authRequired: true }, next, path: 'test.route' });

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({ userId: 5 }),
      }),
    );
  });
});
