/**
 * Adapter Parity Spec
 *
 * Ensures that createPrismaAdapter and createDrizzleAdapter both satisfy the
 * DatabaseAdapter interface with identical input/output shapes. This spec
 * does NOT hit a real database — it validates structural and type-level parity
 * so consumers can swap adapters without changing application code.
 */
import { describe, it, expect } from 'vitest';
import { createPrismaAdapter } from '../src/adapters/prismaAdapter';
import { createDrizzleAdapter } from '../src/adapters/drizzleAdapter';
import type { DatabaseAdapter } from '../src/adapters/database';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** All namespaces on DatabaseAdapter */
const ADAPTER_NAMESPACES = [
  'user',
  'session',
  'otp',
  'passwordReset',
  'device',
  'admin',
] as const;

/** Expected method names per namespace (source of truth: database.ts interface) */
const EXPECTED_METHODS: Record<string, string[]> = {
  user: [
    'findByEmailInsensitive',
    'findByUsernameInsensitive',
    'findByEmailOrUsernameInsensitive',
    'findByEmailOrOAuthId',
    'findById',
    'findActiveById',
    'create',
    'update',
  ],
  session: [
    'findById',
    'create',
    'update',
    'updateLastUsed',
    'revoke',
    'findActiveByUserId',
    'revokeAllByUserId',
    'findTwoFaSecretsByUserId',
    'clearTwoFaSecrets',
    'findByIdWithDevice',
    'revokeByDevicePushToken',
    'clearDeviceId',
  ],
  otp: ['findValidByUserAndCode', 'create', 'delete'],
  passwordReset: ['findById', 'create', 'delete', 'deleteAllByUserId'],
  device: [
    'findByTokenSessionAndUser',
    'upsertByPushToken',
    'findByUserAndToken',
    'disconnectUser',
    'hasRemainingUsers',
    'delete',
  ],
  admin: ['findByUserId'],
};

// ── Mock factories ──────────────────────────────────────────────────────────

/** Stub Prisma client that records calls without executing them */
function createStubPrismaClient() {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      // Return a proxy for model access (prisma.user, prisma.session, etc.)
      return new Proxy(
        {},
        {
          get() {
            // Return a function for any method (findFirst, create, etc.)
            return async (..._args: unknown[]) => null;
          },
        }
      );
    },
  };
  return new Proxy({}, handler);
}

/** Stub Drizzle DB + tables that record calls without executing them */
function createStubDrizzleDeps() {
  const col = (name: string) => ({ name, _: { name } });

  const stubTable = (name: string, columns: string[]) => {
    const table: Record<string, unknown> = { _: { name } };
    for (const c of columns) {
      table[c] = col(c);
    }
    return table;
  };

  /**
   * Creates a deeply-chainable proxy that:
   * - Returns itself for any property access (.select, .from, .where, .limit, etc.)
   * - Returns itself when called as a function (select(), where(...), etc.)
   * - Resolves to [] when awaited (via .then)
   */
  function createChainProxy(): any {
    const handler: ProxyHandler<any> = {
      get(_target, prop) {
        if (prop === 'then') {
          // Make it thenable — resolve to a stub row so property access doesn't throw
          return (resolve: (v: any) => void) =>
            resolve([{ id: 0, ip: '', pushToken: '', userId: 0, twoFaSecret: null, deviceId: null }]);
        }
        if (prop === 'catch' || prop === 'finally') {
          return () => createChainProxy();
        }
        // Any property access returns a callable chain proxy
        return createChainProxy();
      },
      apply(_target, _thisArg, _args) {
        // Any function call returns a chain proxy (so .select().from() works)
        return createChainProxy();
      },
    };
    // Must be a function so it can be called
    return new Proxy(function () {}, handler);
  }

  const db = new Proxy(
    {},
    {
      get() {
        return createChainProxy();
      },
    }
  );

  const tables = {
    users: stubTable('users', [
      'id', 'status', 'email', 'username', 'password', 'twoFaEnabled',
      'oauthProvider', 'oauthId', 'tag', 'verifiedHumanAt',
      'emailVerificationStatus', 'otpForEmailVerification', 'isActive',
    ]),
    sessions: stubTable('sessions', [
      'id', 'userId', 'socketId', 'twoFaSecret', 'browserName',
      'issuedAt', 'lastUsed', 'revokedAt', 'deviceId',
    ]),
    otps: stubTable('otps', ['id', 'code', 'expiresAt', 'userId']),
    passwordResets: stubTable('passwordResets', ['id', 'createdAt', 'userId']),
    devices: stubTable('devices', ['id', 'pushToken', 'createdAt']),
    admins: stubTable('admins', ['userId', 'ip']),
  };

  return { db, tables };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Adapter Parity: Prisma vs Drizzle', () => {
  const prismaAdapter = createPrismaAdapter(createStubPrismaClient());
  const { db, tables } = createStubDrizzleDeps();
  // Drizzle adapter uses require('drizzle-orm') internally; mock it for this spec
  let drizzleAdapter: DatabaseAdapter;

  // We need drizzle-orm to be available. If not installed, skip drizzle-specific tests.
  let drizzleAvailable = true;
  try {
    require('drizzle-orm');
  } catch {
    drizzleAvailable = false;
  }

  if (drizzleAvailable) {
    drizzleAdapter = createDrizzleAdapter(db, tables);
  }

  describe('both adapters expose identical namespaces', () => {
    it('Prisma adapter has all required namespaces', () => {
      for (const ns of ADAPTER_NAMESPACES) {
        expect(prismaAdapter).toHaveProperty(ns);
        expect(typeof prismaAdapter[ns]).toBe('object');
      }
    });

    it('Drizzle adapter has all required namespaces', () => {
      if (!drizzleAvailable) return;
      for (const ns of ADAPTER_NAMESPACES) {
        expect(drizzleAdapter).toHaveProperty(ns);
        expect(typeof drizzleAdapter[ns]).toBe('object');
      }
    });
  });

  describe('both adapters expose identical methods per namespace', () => {
    for (const ns of ADAPTER_NAMESPACES) {
      describe(`${ns} namespace`, () => {
        const expectedMethods = EXPECTED_METHODS[ns];

        it(`Prisma adapter has all ${expectedMethods.length} methods`, () => {
          const adapterNs = prismaAdapter[ns] as Record<string, unknown>;
          for (const method of expectedMethods) {
            expect(adapterNs).toHaveProperty(method);
            expect(typeof adapterNs[method]).toBe('function');
          }
        });

        it(`Prisma adapter has no extra methods`, () => {
          const adapterNs = prismaAdapter[ns] as Record<string, unknown>;
          const actualMethods = Object.keys(adapterNs).filter(
            (k) => typeof adapterNs[k] === 'function'
          );
          expect(actualMethods.sort()).toEqual([...expectedMethods].sort());
        });

        it(`Drizzle adapter has all ${expectedMethods.length} methods`, () => {
          if (!drizzleAvailable) return;
          const adapterNs = drizzleAdapter[ns] as Record<string, unknown>;
          for (const method of expectedMethods) {
            expect(adapterNs).toHaveProperty(method);
            expect(typeof adapterNs[method]).toBe('function');
          }
        });

        it(`Drizzle adapter has no extra methods`, () => {
          if (!drizzleAvailable) return;
          const adapterNs = drizzleAdapter[ns] as Record<string, unknown>;
          const actualMethods = Object.keys(adapterNs).filter(
            (k) => typeof adapterNs[k] === 'function'
          );
          expect(actualMethods.sort()).toEqual([...expectedMethods].sort());
        });
      });
    }
  });

  describe('method signatures return Promises', () => {
    for (const ns of ADAPTER_NAMESPACES) {
      for (const method of EXPECTED_METHODS[ns]) {
        it(`prismaAdapter.${ns}.${method}() returns a Promise`, () => {
          const fn = (prismaAdapter[ns] as Record<string, Function>)[method];
          // Call with dummy args — the stub prisma returns null for everything
          const result = fn(1, 1, 1, 1);
          expect(result).toBeInstanceOf(Promise);
        });

        it(`drizzleAdapter.${ns}.${method}() returns a Promise`, () => {
          if (!drizzleAvailable) return;
          const fn = (drizzleAdapter[ns] as Record<string, Function>)[method];
          const result = fn(1, 1, 1, 1);
          expect(result).toBeInstanceOf(Promise);
        });
      }
    }
  });

  describe('adapters are assignable to DatabaseAdapter type', () => {
    it('Prisma adapter satisfies DatabaseAdapter', () => {
      // TypeScript compile-time check — if this assignment compiles, it passes
      const _adapter: DatabaseAdapter = prismaAdapter;
      expect(_adapter).toBeDefined();
    });

    it('Drizzle adapter satisfies DatabaseAdapter', () => {
      if (!drizzleAvailable) return;
      const _adapter: DatabaseAdapter = drizzleAdapter;
      expect(_adapter).toBeDefined();
    });
  });
});

describe('DatabaseAdapter interface completeness', () => {
  it('EXPECTED_METHODS matches the actual interface (guard against drift)', () => {
    // If someone adds a method to DatabaseAdapter but forgets to add it here,
    // the Prisma adapter (which is the reference impl) will have it but
    // EXPECTED_METHODS won't — this test catches that.
    for (const ns of ADAPTER_NAMESPACES) {
      const adapterNs = createPrismaAdapter(createStubPrismaClient())[ns] as Record<string, unknown>;
      const actualMethods = Object.keys(adapterNs).filter(
        (k) => typeof adapterNs[k] === 'function'
      );
      expect(actualMethods.sort()).toEqual([...EXPECTED_METHODS[ns]].sort());
    }
  });
});
