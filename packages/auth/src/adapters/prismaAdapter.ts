import type {
  AuthMagicLink,
  AuthOTP,
  AuthPasswordReset,
  AuthSession,
  AuthUser,
  CreateSessionData,
  CreateUserData,
  DatabaseAdapter,
  SessionWithUser,
} from './database';
import type { DeviceAuthAdapter, SessionWithDevice } from './deviceAuth';

/** Internal accessor for Prisma model delegates (avoids repeating casts). */
type PrismaDelegate = Record<string, (...args: unknown[]) => Promise<unknown>>;
interface PrismaModelAccess {
  user: PrismaDelegate;
  session: PrismaDelegate;
  oTP: PrismaDelegate;
  passwordReset: PrismaDelegate;
  device: PrismaDelegate;
  admin: PrismaDelegate;
  magicLink?: PrismaDelegate;
  $transaction?: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
}

/**
 * Creates a core DatabaseAdapter backed by Prisma.
 *
 * This adapter targets the **standard** schema: `User.twoFaSecret` /
 * `User.twoFaBackupCodes` columns, no `Device` table, no per-session 2FA
 * columns. See `prisma/schema.standard.prisma` for the reference schema.
 *
 * If you need the legacy device/push-token 2FA flow, ALSO pass
 * `createPrismaDeviceAdapter(prisma)` as `deviceAuth` on AuthConfig.
 *
 * Pass your generated PrismaClient instance — its full types are preserved
 * at the call site.
 */
export function createPrismaAdapter(prisma: unknown): DatabaseAdapter {
  const db = prisma as PrismaModelAccess;
  return {
    user: {
      async findByEmailInsensitive(email: string): Promise<AuthUser | null> {
        return db.user.findFirst({
          where: { email: { equals: email, mode: 'insensitive' } },
        }) as Promise<AuthUser | null>;
      },

      async findByUsernameInsensitive(username: string): Promise<AuthUser | null> {
        return db.user.findFirst({
          where: { username: { equals: username, mode: 'insensitive' } },
        }) as Promise<AuthUser | null>;
      },

      async findByEmailOrUsernameInsensitive(identifier: string): Promise<AuthUser | null> {
        return db.user.findFirst({
          where: {
            OR: [
              { email: { equals: identifier, mode: 'insensitive' } },
              { username: { equals: identifier, mode: 'insensitive' } },
            ],
          },
        }) as Promise<AuthUser | null>;
      },

      async findByEmailOrOAuthId(email: string, oauthId: string): Promise<AuthUser | null> {
        return db.user.findFirst({
          where: {
            OR: [
              { email: { equals: email, mode: 'insensitive' } },
              { oauthId: { equals: oauthId } },
            ],
          },
        }) as Promise<AuthUser | null>;
      },

      async findById(id: number): Promise<AuthUser | null> {
        return db.user.findUnique({ where: { id } }) as Promise<AuthUser | null>;
      },

      async findActiveById(id: number): Promise<AuthUser | null> {
        return db.user.findUnique({
          where: { id, status: 'ACTIVE' },
        }) as Promise<AuthUser | null>;
      },

      async create(data: CreateUserData): Promise<AuthUser> {
        return db.user.create({ data }) as Promise<AuthUser>;
      },

      async update(id: number, data: Partial<Omit<AuthUser, 'id'>>): Promise<AuthUser> {
        return db.user.update({ where: { id }, data }) as Promise<AuthUser>;
      },

      async findTwoFaSecret(
        id: number
      ): Promise<{ twoFaSecret: string | null; twoFaBackupCodes: string[] }> {
        const row = (await db.user.findUnique({
          where: { id },
          select: { twoFaSecret: true, twoFaBackupCodes: true },
        })) as { twoFaSecret: string | null; twoFaBackupCodes: string[] } | null;
        return {
          twoFaSecret: row?.twoFaSecret ?? null,
          twoFaBackupCodes: row?.twoFaBackupCodes ?? [],
        };
      },

      async setTwoFaSecret(
        id: number,
        secret: string,
        backupCodes: string[]
      ): Promise<void> {
        await db.user.update({
          where: { id },
          data: { twoFaSecret: secret, twoFaBackupCodes: backupCodes },
        });
      },

      async setBackupCodes(id: number, backupCodes: string[]): Promise<void> {
        await db.user.update({
          where: { id },
          data: { twoFaBackupCodes: backupCodes },
        });
      },

      async clearTwoFaSecret(id: number): Promise<void> {
        await db.user.update({
          where: { id },
          data: { twoFaSecret: null, twoFaBackupCodes: [], twoFaEnabled: false },
        });
      },

      async consumeBackupCode(id: number, code: string): Promise<boolean> {
        // Read-modify-write inside a transaction so concurrent uses can't
        // both consume the same backup code.
        const tx = db.$transaction;
        if (!tx) {
          // Fallback for stub clients that don't expose $transaction (tests).
          const row = (await db.user.findUnique({
            where: { id },
            select: { twoFaBackupCodes: true },
          })) as { twoFaBackupCodes: string[] } | null;
          if (!row) return false;
          const idx = row.twoFaBackupCodes.indexOf(code);
          if (idx === -1) return false;
          const next = [...row.twoFaBackupCodes.slice(0, idx), ...row.twoFaBackupCodes.slice(idx + 1)];
          await db.user.update({
            where: { id },
            data: { twoFaBackupCodes: next },
          });
          return true;
        }
        return tx<boolean>(async (txClient: unknown) => {
          const txDb = txClient as PrismaModelAccess;
          const row = (await txDb.user.findUnique({
            where: { id },
            select: { twoFaBackupCodes: true },
          })) as { twoFaBackupCodes: string[] } | null;
          if (!row) return false;
          const idx = row.twoFaBackupCodes.indexOf(code);
          if (idx === -1) return false;
          const next = [...row.twoFaBackupCodes.slice(0, idx), ...row.twoFaBackupCodes.slice(idx + 1)];
          await txDb.user.update({
            where: { id },
            data: { twoFaBackupCodes: next },
          });
          return true;
        });
      },
    },

    session: {
      async findById(id: number): Promise<SessionWithUser | null> {
        const session = await db.session.findUnique({
          where: { id },
          select: {
            id: true,
            userId: true,
            socketId: true,
            browserName: true,
            issuedAt: true,
            lastUsed: true,
            revokedAt: true,
            user: { select: { status: true, verifiedHumanAt: true, updatedAt: true } },
          },
        });
        return session as SessionWithUser | null;
      },

      async create(data: CreateSessionData): Promise<AuthSession> {
        return db.session.create({ data }) as Promise<AuthSession>;
      },

      async update(
        id: number,
        data: Partial<Pick<AuthSession, 'revokedAt' | 'lastUsed'>>
      ): Promise<AuthSession> {
        return db.session.update({ where: { id }, data }) as Promise<AuthSession>;
      },

      async updateLastUsed(
        id: number
      ): Promise<AuthSession & { user: { verifiedHumanAt: Date | null; updatedAt: Date } }> {
        const session = await db.session.update({
          where: { id },
          data: { lastUsed: new Date() },
          select: {
            id: true,
            userId: true,
            socketId: true,
            browserName: true,
            issuedAt: true,
            lastUsed: true,
            revokedAt: true,
            user: { select: { verifiedHumanAt: true, updatedAt: true } },
          },
        });
        return session as AuthSession & { user: { verifiedHumanAt: Date | null; updatedAt: Date } };
      },

      async revoke(id: number): Promise<void> {
        await db.session.update({
          where: { id },
          data: { revokedAt: new Date() },
        });
      },

      async findActiveByUserId(
        userId: number,
        excludeSessionId?: number
      ): Promise<Pick<AuthSession, 'id' | 'socketId' | 'userId'>[]> {
        return db.session.findMany({
          where: {
            userId,
            revokedAt: null,
            ...(excludeSessionId ? { NOT: { id: excludeSessionId } } : {}),
          },
          select: { id: true, socketId: true, userId: true },
        }) as Promise<Pick<AuthSession, 'id' | 'socketId' | 'userId'>[]>;
      },

      async revokeAllByUserId(userId: number, excludeSessionId?: number): Promise<void> {
        await db.session.updateMany({
          where: {
            userId,
            revokedAt: null,
            ...(excludeSessionId ? { NOT: { id: excludeSessionId } } : {}),
          },
          data: { revokedAt: new Date() },
        });
      },
    },

    otp: {
      async findValidByUserAndCode(userId: number, code: number): Promise<AuthOTP | null> {
        return db.oTP.findFirst({
          where: { userId, code, expiresAt: { gte: new Date() } },
        }) as Promise<AuthOTP | null>;
      },

      async create(data: { userId: number; code: number; expiresAt: Date }): Promise<AuthOTP> {
        return db.oTP.create({ data }) as Promise<AuthOTP>;
      },

      async delete(id: number): Promise<void> {
        await db.oTP.delete({ where: { id } });
      },
    },

    passwordReset: {
      async findById(id: string): Promise<AuthPasswordReset | null> {
        return db.passwordReset.findUnique({
          where: { id },
          select: { id: true, createdAt: true, userId: true },
        }) as Promise<AuthPasswordReset | null>;
      },

      async create(userId: number): Promise<AuthPasswordReset> {
        return db.passwordReset.create({
          data: { userId },
        }) as Promise<AuthPasswordReset>;
      },

      async delete(id: string): Promise<void> {
        await db.passwordReset.delete({ where: { id } });
      },

      async deleteAllByUserId(userId: number): Promise<void> {
        await db.passwordReset.deleteMany({ where: { userId } });
      },
    },

    admin: {
      async findByUserId(userId: number): Promise<{ ip: string } | null> {
        return db.admin.findFirst({
          where: { userId },
          select: { ip: true },
        }) as Promise<{ ip: string } | null>;
      },
    },

    // Only populated when the consumer's Prisma schema includes MagicLink
    ...(db.magicLink
      ? {
          magicLink: {
            async findById(id: string): Promise<AuthMagicLink | null> {
              return db.magicLink!.findUnique({ where: { id } }) as Promise<AuthMagicLink | null>;
            },

            async create(data: { userId: number; expiresAt: Date }): Promise<AuthMagicLink> {
              return db.magicLink!.create({ data }) as Promise<AuthMagicLink>;
            },

            async markUsed(id: string): Promise<AuthMagicLink> {
              return db.magicLink!.update({
                where: { id },
                data: { usedAt: new Date() },
              }) as Promise<AuthMagicLink>;
            },
          },
        }
      : {}),
  };
}

/**
 * Creates a DeviceAuthAdapter backed by Prisma — the device-mode 2FA add-on.
 *
 * Pass this as `deviceAuth` on `AuthConfig` when using
 * `features.twoFaMode: 'device'`. Targets the legacy schema with
 * `Session.twoFaSecret`, `Session.deviceId`, and the `Device` table — see
 * `prisma/schema.device.prisma`.
 *
 * Standard-mode consumers do NOT need this — leave `deviceAuth` undefined.
 */
export function createPrismaDeviceAdapter(prisma: unknown): DeviceAuthAdapter {
  const db = prisma as PrismaModelAccess;
  return {
    session: {
      async findTwoFaSecretsByUserId(
        userId: number
      ): Promise<{ twoFaSecret: string | null }[]> {
        return db.session.findMany({
          where: { userId, twoFaSecret: { not: null } },
          select: { twoFaSecret: true },
        }) as Promise<{ twoFaSecret: string | null }[]>;
      },

      async clearTwoFaSecrets(userId: number, excludeSessionId?: number): Promise<void> {
        await db.session.updateMany({
          where: {
            userId,
            ...(excludeSessionId ? { NOT: { id: excludeSessionId } } : {}),
          },
          data: { twoFaSecret: null },
        });
      },

      async setTwoFaSecret(sessionId: number, secret: string | null): Promise<void> {
        await db.session.update({
          where: { id: sessionId },
          data: { twoFaSecret: secret },
        });
      },

      async findByIdWithDevice(
        id: number,
        userId: number
      ): Promise<SessionWithDevice | null> {
        const session = await db.session.findUnique({
          where: { id, userId },
          select: {
            twoFaSecret: true,
            deviceId: true,
            device: { select: { pushToken: true } },
          },
        });
        return session as SessionWithDevice | null;
      },

      async getDeviceId(sessionId: number, userId: number): Promise<number | null> {
        const row = (await db.session.findUnique({
          where: { id: sessionId, userId },
          select: { deviceId: true },
        })) as { deviceId: number | null } | null;
        return row?.deviceId ?? null;
      },

      async revokeByDevicePushToken(
        userId: number,
        pushToken: string,
        excludeSessionId: number
      ): Promise<void> {
        await db.session.updateMany({
          where: {
            userId,
            id: { not: excludeSessionId },
            revokedAt: null,
            device: { pushToken },
          },
          data: { revokedAt: new Date() },
        });
      },

      async clearDeviceId(userId: number, deviceId: number): Promise<void> {
        await db.session.updateMany({
          where: { userId, deviceId },
          data: { deviceId: null },
        });
      },
    },

    device: {
      async findByTokenSessionAndUser(
        pushToken: string,
        sessionId: number,
        userId: number
      ): Promise<{ id: number } | null> {
        return db.device.findFirst({
          where: {
            pushToken,
            sessions: { some: { id: sessionId } },
            users: { some: { id: userId } },
          },
          select: { id: true },
        }) as Promise<{ id: number } | null>;
      },

      async upsertByPushToken(
        pushToken: string,
        sessionId: number,
        userId: number
      ): Promise<void> {
        await db.device.upsert({
          where: { pushToken },
          create: {
            pushToken,
            sessions: { connect: { id: sessionId } },
            users: { connect: { id: userId } },
          },
          update: {
            sessions: { connect: { id: sessionId } },
            users: { connect: { id: userId } },
          },
        });
      },

      async findByUserAndToken(
        userId: number,
        pushToken: string
      ): Promise<{ id: number } | null> {
        return db.device.findFirst({
          where: { users: { some: { id: userId } }, pushToken },
          select: { id: true },
        }) as Promise<{ id: number } | null>;
      },

      async disconnectUser(deviceId: number, userId: number): Promise<void> {
        await db.device.update({
          where: { id: deviceId },
          data: { users: { disconnect: { id: userId } } },
        });
      },

      async hasRemainingUsers(deviceId: number): Promise<boolean> {
        const result = (await db.device.findUnique({
          where: { id: deviceId },
          select: { users: { select: { id: true }, take: 1 } },
        })) as { users: { id: number }[] } | null;
        return (result?.users.length ?? 0) > 0;
      },

      async delete(id: number): Promise<void> {
        await db.device.delete({ where: { id } });
      },
    },
  };
}
