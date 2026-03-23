import { describe, it, expect } from 'vitest';
import {
  createAuthConfig,
  defaultTokenSettings,
  defaultCookieSettings,
  defaultFeatures,
  defaultStorageKeys,
} from '../src/utilities/config';
import type { DatabaseAdapter } from '../src/adapters/database';

// Minimal mock prisma client (backwards compat)
const mockPrisma = {} as any;

// Minimal mock database adapter
const mockDatabase: DatabaseAdapter = {
  user: {
    findByEmailInsensitive: async () => null,
    findByUsernameInsensitive: async () => null,
    findByEmailOrUsernameInsensitive: async () => null,
    findByEmailOrOAuthId: async () => null,
    findById: async () => null,
    findActiveById: async () => null,
    create: async (data) => ({ id: 1, isActive: true, ...data } as any),
    update: async (_id, data) => ({ id: _id, ...data } as any),
  },
  session: {
    findById: async () => null,
    create: async (data) => ({ id: 1, ...data } as any),
    update: async (_id, data) => ({ id: _id, ...data } as any),
    updateLastUsed: async (id) => ({ id, user: { verifiedHumanAt: null } } as any),
    revoke: async () => {},
    findActiveByUserId: async () => [],
    revokeAllByUserId: async () => {},
    findTwoFaSecretsByUserId: async () => [],
    clearTwoFaSecrets: async () => {},
    findByIdWithDevice: async () => null,
    revokeByDevicePushToken: async () => {},
    clearDeviceId: async () => {},
  },
  otp: {
    findValidByUserAndCode: async () => null,
    create: async (data) => ({ id: 1, ...data } as any),
    delete: async () => {},
  },
  passwordReset: {
    findById: async () => null,
    create: async (userId) => ({ id: 'reset-1', createdAt: new Date(), userId }),
    delete: async () => {},
    deleteAllByUserId: async () => {},
  },
  device: {
    findByTokenSessionAndUser: async () => null,
    upsertByPushToken: async () => {},
    findByUserAndToken: async () => null,
    disconnectUser: async () => {},
    hasRemainingUsers: async () => false,
    delete: async () => {},
  },
  admin: {
    findByUserId: async () => null,
  },
};

describe('createAuthConfig', () => {
  it('applies all defaults when only required fields given (prisma compat)', () => {
    const config = createAuthConfig({
      prisma: mockPrisma,
      secrets: { jwt: 'secret' },
    });

    expect(config.tokenSettings).toEqual(defaultTokenSettings);
    expect(config.cookieSettings).toEqual(defaultCookieSettings);
    expect(config.features).toEqual(defaultFeatures);
    expect(config.storageKeys).toEqual(defaultStorageKeys);
    expect(config.emailService).toBeDefined();
    expect(config.database).toBeDefined();
    expect(typeof config.generateUsername).toBe('function');
  });

  it('accepts database adapter directly', () => {
    const config = createAuthConfig({
      database: mockDatabase,
      secrets: { jwt: 'secret' },
    });

    expect(config.database).toBe(mockDatabase);
    expect(config.tokenSettings).toEqual(defaultTokenSettings);
  });

  it('throws when neither prisma nor database is provided', () => {
    expect(() =>
      createAuthConfig({
        secrets: { jwt: 'secret' },
      })
    ).toThrow('Provide either a `database` adapter or a `prisma` client');
  });

  it('prefers database adapter over prisma when both provided', () => {
    const config = createAuthConfig({
      prisma: mockPrisma,
      database: mockDatabase,
      secrets: { jwt: 'secret' },
    });

    expect(config.database).toBe(mockDatabase);
  });

  it('merges partial token settings', () => {
    const config = createAuthConfig({
      prisma: mockPrisma,
      secrets: { jwt: 'secret' },
      tokenSettings: { jwtExpiry: 60 },
    });

    expect(config.tokenSettings.jwtExpiry).toBe(60);
    expect(config.tokenSettings.passwordResetExpiryMs).toBe(defaultTokenSettings.passwordResetExpiryMs);
  });

  it('merges partial feature flags', () => {
    const config = createAuthConfig({
      prisma: mockPrisma,
      secrets: { jwt: 'secret' },
      features: { twoFa: false },
    });

    expect(config.features.twoFa).toBe(false);
    expect(config.features.emailVerification).toBe(defaultFeatures.emailVerification);
  });

  it('uses custom generateUsername', () => {
    const config = createAuthConfig({
      prisma: mockPrisma,
      secrets: { jwt: 'secret' },
      generateUsername: () => 'custom_user',
    });

    expect(config.generateUsername()).toBe('custom_user');
  });

  it('default generateUsername produces a string', () => {
    const config = createAuthConfig({
      prisma: mockPrisma,
      secrets: { jwt: 'secret' },
    });

    const name = config.generateUsername();
    expect(name).toMatch(/^user_\d+$/);
  });
});

describe('defaultTokenSettings', () => {
  it('has expected defaults', () => {
    expect(defaultTokenSettings.jwtExpiry).toBe(365 * 24 * 60 * 60);
    expect(defaultTokenSettings.passwordResetExpiryMs).toBe(60 * 60 * 1000);
    expect(defaultTokenSettings.otpValidityMs).toBe(15 * 60 * 1000);
  });
});
