/**
 * Adapter Parity Spec
 *
 * Ensures that:
 * 1. createPrismaAdapter and createDrizzleAdapter both satisfy the *core*
 *    DatabaseAdapter interface (no device methods, user-level 2FA).
 * 2. createPrismaDeviceAdapter and createDrizzleDeviceAdapter both satisfy
 *    the DeviceAuthAdapter interface (per-session 2FA + device CRUD).
 *
 * This spec does NOT hit a real database — it validates structural and
 * type-level parity so consumers can swap adapters without changing
 * application code.
 */
import { describe, it, expect } from 'vitest';
import { createPrismaAdapter, createPrismaDeviceAdapter } from '../src/adapters/prismaAdapter';
import {
  createDrizzleAdapter,
  createDrizzleDeviceAdapter,
} from '../src/adapters/drizzleAdapter';
import type { DatabaseAdapter } from '../src/adapters/database';
import type { DeviceAuthAdapter } from '../src/adapters/deviceAuth';

// ── Core DatabaseAdapter expectations ───────────────────────────────────────

const ADAPTER_NAMESPACES = ['user', 'session', 'otp', 'passwordReset', 'admin'] as const;

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
    'findTwoFaSecret',
    'setTwoFaSecret',
    'setBackupCodes',
    'clearTwoFaSecret',
    'consumeBackupCode',
  ],
  session: [
    'findById',
    'create',
    'update',
    'updateLastUsed',
    'revoke',
    'findActiveByUserId',
    'revokeAllByUserId',
  ],
  otp: ['findValidByUserAndCode', 'create', 'delete'],
  passwordReset: ['findById', 'create', 'delete', 'deleteAllByUserId'],
  admin: ['findByUserId'],
};

// ── DeviceAuthAdapter expectations ──────────────────────────────────────────

const DEVICE_NAMESPACES = ['session', 'device'] as const;

const DEVICE_EXPECTED_METHODS: Record<string, string[]> = {
  session: [
    'findTwoFaSecretsByUserId',
    'clearTwoFaSecrets',
    'setTwoFaSecret',
    'findByIdWithDevice',
    'getDeviceId',
    'revokeByDevicePushToken',
    'clearDeviceId',
  ],
  device: [
    'findByTokenSessionAndUser',
    'upsertByPushToken',
    'findByUserAndToken',
    'disconnectUser',
    'hasRemainingUsers',
    'delete',
  ],
};

// ── Mock factories ──────────────────────────────────────────────────────────

/** Stub Prisma client that records calls without executing them */
function createStubPrismaClient() {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === '$transaction') {
        // Allow consumeBackupCode's transaction path to no-op.
        return undefined;
      }
      return new Proxy(
        {},
        {
          get() {
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function createChainProxy(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler: ProxyHandler<any> = {
      get(_target, prop) {
        if (prop === 'then') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (resolve: (v: any) => void) =>
            resolve([
              {
                id: 0,
                ip: '',
                pushToken: '',
                userId: 0,
                twoFaSecret: null,
                twoFaBackupCodes: [],
                deviceId: null,
              },
            ]);
        }
        if (prop === 'catch' || prop === 'finally') {
          return () => createChainProxy();
        }
        return createChainProxy();
      },
      apply(_target, _thisArg, _args) {
        return createChainProxy();
      },
    };
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
      'twoFaSecret', 'twoFaBackupCodes',
      'oauthProvider', 'oauthId', 'tag', 'verifiedHumanAt',
      'emailVerificationStatus', 'otpForEmailVerification', 'isActive',
    ]),
    sessions: stubTable('sessions', [
      'id', 'userId', 'socketId', 'browserName',
      'issuedAt', 'lastUsed', 'revokedAt',
    ]),
    otps: stubTable('otps', ['id', 'code', 'expiresAt', 'userId']),
    passwordResets: stubTable('passwordResets', ['id', 'createdAt', 'userId']),
    admins: stubTable('admins', ['userId', 'ip']),
  };

  // Device-mode tables (separate set, additive on the sessions table).
  const deviceSessions = stubTable('sessions', [
    'id', 'userId', 'socketId', 'twoFaSecret', 'browserName',
    'issuedAt', 'lastUsed', 'revokedAt', 'deviceId',
  ]);

  const deviceTables = {
    sessions: deviceSessions,
    devices: stubTable('devices', ['id', 'pushToken', 'createdAt']),
  };

  return { db, tables, deviceTables };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Core DatabaseAdapter parity: Prisma vs Drizzle', () => {
  const prismaAdapter = createPrismaAdapter(createStubPrismaClient());
  const { db, tables } = createStubDrizzleDeps();
  let drizzleAdapter: DatabaseAdapter;

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
        expect(typeof (drizzleAdapter as unknown as Record<string, unknown>)[ns]).toBe('object');
      }
    });

    it('Core adapters do NOT expose `device` namespace', () => {
      expect(prismaAdapter).not.toHaveProperty('device');
      if (!drizzleAvailable) return;
      expect(drizzleAdapter).not.toHaveProperty('device');
    });
  });

  describe('both adapters expose identical methods per namespace', () => {
    for (const ns of ADAPTER_NAMESPACES) {
      describe(`${ns} namespace`, () => {
        const expectedMethods = EXPECTED_METHODS[ns];

        it(`Prisma adapter has all ${expectedMethods.length} methods`, () => {
          const adapterNs = (prismaAdapter as unknown as Record<string, Record<string, unknown>>)[ns];
          for (const method of expectedMethods) {
            expect(adapterNs).toHaveProperty(method);
            expect(typeof adapterNs[method]).toBe('function');
          }
        });

        it(`Prisma adapter has no extra methods`, () => {
          const adapterNs = (prismaAdapter as unknown as Record<string, Record<string, unknown>>)[ns];
          const actualMethods = Object.keys(adapterNs).filter(
            (k) => typeof adapterNs[k] === 'function'
          );
          expect(actualMethods.sort()).toEqual([...expectedMethods].sort());
        });

        it(`Drizzle adapter has all ${expectedMethods.length} methods`, () => {
          if (!drizzleAvailable) return;
          const adapterNs = (drizzleAdapter as unknown as Record<string, Record<string, unknown>>)[ns];
          for (const method of expectedMethods) {
            expect(adapterNs).toHaveProperty(method);
            expect(typeof adapterNs[method]).toBe('function');
          }
        });

        it(`Drizzle adapter has no extra methods`, () => {
          if (!drizzleAvailable) return;
          const adapterNs = (drizzleAdapter as unknown as Record<string, Record<string, unknown>>)[ns];
          const actualMethods = Object.keys(adapterNs).filter(
            (k) => typeof adapterNs[k] === 'function'
          );
          expect(actualMethods.sort()).toEqual([...expectedMethods].sort());
        });
      });
    }
  });

  describe('adapters are assignable to DatabaseAdapter type', () => {
    it('Prisma adapter satisfies DatabaseAdapter', () => {
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

describe('DeviceAuthAdapter parity: Prisma vs Drizzle', () => {
  const prismaDevice = createPrismaDeviceAdapter(createStubPrismaClient());
  const { db, deviceTables } = createStubDrizzleDeps();
  let drizzleDevice: DeviceAuthAdapter;

  let drizzleAvailable = true;
  try {
    require('drizzle-orm');
  } catch {
    drizzleAvailable = false;
  }

  if (drizzleAvailable) {
    drizzleDevice = createDrizzleDeviceAdapter(db, deviceTables);
  }

  describe('both device adapters expose identical namespaces', () => {
    it('Prisma device adapter has session + device namespaces', () => {
      for (const ns of DEVICE_NAMESPACES) {
        expect(prismaDevice).toHaveProperty(ns);
      }
    });

    it('Drizzle device adapter has session + device namespaces', () => {
      if (!drizzleAvailable) return;
      for (const ns of DEVICE_NAMESPACES) {
        expect(drizzleDevice).toHaveProperty(ns);
      }
    });
  });

  describe('both device adapters expose identical methods per namespace', () => {
    for (const ns of DEVICE_NAMESPACES) {
      describe(`${ns} namespace`, () => {
        const expectedMethods = DEVICE_EXPECTED_METHODS[ns];

        it(`Prisma device adapter has all ${expectedMethods.length} methods`, () => {
          const adapterNs = (prismaDevice as unknown as Record<string, Record<string, unknown>>)[ns];
          for (const method of expectedMethods) {
            expect(adapterNs).toHaveProperty(method);
            expect(typeof adapterNs[method]).toBe('function');
          }
        });

        it(`Prisma device adapter has no extra methods`, () => {
          const adapterNs = (prismaDevice as unknown as Record<string, Record<string, unknown>>)[ns];
          const actualMethods = Object.keys(adapterNs).filter(
            (k) => typeof adapterNs[k] === 'function'
          );
          expect(actualMethods.sort()).toEqual([...expectedMethods].sort());
        });

        it(`Drizzle device adapter has all ${expectedMethods.length} methods`, () => {
          if (!drizzleAvailable) return;
          const adapterNs = (drizzleDevice as unknown as Record<string, Record<string, unknown>>)[ns];
          for (const method of expectedMethods) {
            expect(adapterNs).toHaveProperty(method);
            expect(typeof adapterNs[method]).toBe('function');
          }
        });

        it(`Drizzle device adapter has no extra methods`, () => {
          if (!drizzleAvailable) return;
          const adapterNs = (drizzleDevice as unknown as Record<string, Record<string, unknown>>)[ns];
          const actualMethods = Object.keys(adapterNs).filter(
            (k) => typeof adapterNs[k] === 'function'
          );
          expect(actualMethods.sort()).toEqual([...expectedMethods].sort());
        });
      });
    }
  });

  it('Prisma device adapter satisfies DeviceAuthAdapter', () => {
    const _adapter: DeviceAuthAdapter = prismaDevice;
    expect(_adapter).toBeDefined();
  });

  it('Drizzle device adapter satisfies DeviceAuthAdapter', () => {
    if (!drizzleAvailable) return;
    const _adapter: DeviceAuthAdapter = drizzleDevice;
    expect(_adapter).toBeDefined();
  });
});
