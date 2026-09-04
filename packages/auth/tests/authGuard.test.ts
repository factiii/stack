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
function buildGuard(
  sessionLookup: (id: number) => Promise<SessionWithUser | null>,
  opts: {
    logError?: ReturnType<typeof vi.fn>;
    adminFindByUserId?: ReturnType<typeof vi.fn>;
  } = {}
) {
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
      admin: { findByUserId: opts.adminFindByUserId ?? vi.fn() },
    },
    secrets: { jwt: SECRET },
    ...(opts.logError ? { hooks: { logError: opts.logError } } : {}),
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

describe('authGuard anonymous (no token) requests', () => {
  // Regression: tokenless requests to authRequired procedures were logged as
  // CRITICAL SECURITY "Session revoked: No token sent" (1,600+ noise events in
  // factiii prod). A missing token is normal logged-out traffic — reject
  // without logging.
  it('rejects authRequired without logging a SECURITY error', async () => {
    const logError = vi.fn();
    const guard = buildGuard(async () => null, { logError });
    const ctx = makeCtx();
    const next = vi.fn();

    await expect(
      guard({ ctx, meta: { authRequired: true }, next, path: 'sessions.accounts' }),
    ).rejects.toThrow(TRPCError);

    expect(logError).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    // Stale cookies are still cleared on the rejection
    expect(ctx.res.setHeader).toHaveBeenCalled();
  });

  it('passes through as anonymous (userId 0) when auth is not required', async () => {
    const logError = vi.fn();
    const guard = buildGuard(async () => null, { logError });
    const ctx = makeCtx();
    const next = vi.fn(({ ctx: newCtx }) => ({ ctx: newCtx }));

    await guard({ ctx, meta: undefined, next, path: 'pool.status' });

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ ctx: expect.objectContaining({ userId: 0 }) }),
    );
    expect(logError).not.toHaveBeenCalled();
  });
});

describe('authGuard public routes with a dead session', () => {
  // Regression: 0.10.0 moved the UNAUTHORIZED re-throw above the
  // `!meta?.authRequired` fallback, making the fallback unreachable. Every
  // session-integrity failure throws UNAUTHORIZED, so a revoked session broke
  // every public route — including this library's own login, logout and
  // register, which are built on the public procedure. The auth cookie is
  // httpOnly, so a browser in that state could neither clear it nor log in to
  // replace it. Fixed by restoring the pre-0.10.0 ordering.
  const revokedSession = () =>
    makeSession({ id: 1, userId: 5, issuedAt: new Date(), revokedAt: new Date() });

  const tokenFor = (userId: number) =>
    createAuthToken({ id: 1, userId, verifiedHumanAt: null }, { secret: SECRET, expiresIn: 3600 });

  it('passes through as anonymous when the session is revoked', async () => {
    const guard = buildGuard(async () => revokedSession());
    const ctx = makeCtx(tokenFor(5));
    const next = vi.fn(({ ctx: newCtx }) => ({ ctx: newCtx }));

    await guard({ ctx, meta: undefined, next, path: 'auth.login' });

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ ctx: expect.objectContaining({ userId: 0 }) }),
    );
  });

  it('passes through as anonymous when the session is missing entirely', async () => {
    const guard = buildGuard(async () => null);
    const ctx = makeCtx(tokenFor(5));
    const next = vi.fn(({ ctx: newCtx }) => ({ ctx: newCtx }));

    await guard({ ctx, meta: undefined, next, path: 'products.list' });

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ ctx: expect.objectContaining({ userId: 0 }) }),
    );
  });

  it('passes through as anonymous when the token predates the session', async () => {
    const guard = buildGuard(async () =>
      makeSession({ id: 1, userId: 5, issuedAt: new Date(Date.now() + 60_000) }),
    );
    const ctx = makeCtx(tokenFor(5));
    const next = vi.fn(({ ctx: newCtx }) => ({ ctx: newCtx }));

    await guard({ ctx, meta: undefined, next, path: 'auth.register' });

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ ctx: expect.objectContaining({ userId: 0 }) }),
    );
  });

  it('still rejects the same dead session on an authRequired route', async () => {
    const guard = buildGuard(async () => revokedSession());
    const ctx = makeCtx(tokenFor(5));
    const next = vi.fn();

    await expect(
      guard({ ctx, meta: { authRequired: true }, next, path: 'users.me' }),
    ).rejects.toThrow(TRPCError);

    expect(next).not.toHaveBeenCalled();
  });

  it('still rejects a FORBIDDEN failure on a public route', async () => {
    // FORBIDDEN is deliberate refusal (biometric re-verification), not a dead
    // session, so it must keep propagating regardless of authRequired.
    const guard = buildGuard(async () =>
      makeSession({ id: 1, userId: 5, issuedAt: new Date() }),
    );
    const ctx = makeCtx(tokenFor(5));
    const next = vi.fn(() => {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'nope' });
    });

    await expect(
      guard({ ctx, meta: undefined, next, path: 'public.route' }),
    ).rejects.toThrow(TRPCError);
  });
});

describe('revocation log descriptions', () => {
  // Regression: call sites passed pre-prefixed reasons and revokeSession
  // prefixes again, producing "Session revoked: Session revoked: ..." in the
  // admin error log.
  it('logs a single "Session revoked:" prefix when the session is missing', async () => {
    const logError = vi.fn();
    const guard = buildGuard(async () => null, { logError });
    const token = createAuthToken(
      { id: 1, userId: 5, verifiedHumanAt: null },
      { secret: SECRET, expiresIn: 3600 },
    );
    const ctx = makeCtx(token);

    await expect(
      guard({ ctx, meta: { authRequired: true }, next: vi.fn(), path: 'posts.feed' }),
    ).rejects.toThrow(TRPCError);

    expect(logError).toHaveBeenCalledTimes(1);
    const { description, type } = logError.mock.calls[0][0];
    expect(type).toBe('SECURITY');
    expect(description).toBe('Session revoked: Session not found');
    expect(description).not.toMatch(/Session revoked: Session revoked/);
  });

  it('logs a single prefix on admin IP mismatch', async () => {
    const logError = vi.fn();
    const adminFindByUserId = vi.fn(async () => ({ id: 1, ip: '10.0.0.1' }));
    const guard = buildGuard(
      async () => makeSession({ id: 1, userId: 5, issuedAt: new Date(Date.now() - 1000) }),
      { logError, adminFindByUserId },
    );
    const token = createAuthToken(
      { id: 1, userId: 5, verifiedHumanAt: null },
      { secret: SECRET, expiresIn: 3600 },
    );
    const ctx = makeCtx(token); // ctx.ip is 127.0.0.1 — mismatch

    await expect(
      guard({ ctx, meta: { authRequired: true, adminRequired: true }, next: vi.fn(), path: 'admin.errors' }),
    ).rejects.toThrow(TRPCError);

    expect(logError).toHaveBeenCalledTimes(1);
    const { description } = logError.mock.calls[0][0];
    expect(description).toBe('Session revoked: Admin not found or IP mismatch');
    expect(description).not.toMatch(/Session revoked: Session revoked/);
  });
});
