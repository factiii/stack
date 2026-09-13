import type {
  AuthEmailLoginAttempt,
  AuthMagicLink,
  AuthOTP,
  AuthPasswordReset,
  AuthSession,
  AuthUser,
  CreateEmailLoginAttemptData,
  CreateSessionData,
  CreateUserData,
  DatabaseAdapter,
  SessionWithUser,
} from './database';
import type { DeviceAuthAdapter, SessionWithDevice } from './deviceAuth';
import { escapeLikePattern, hasLikeWildcard, sameIdentifier } from '../utilities/emailMatch';

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
  emailLoginAttempt?: PrismaDelegate;
  $transaction?: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
}

/**
 * Case-insensitive EXACT lookup on one or more user columns.
 *
 * Prisma's `mode: 'insensitive'` `equals` is ILIKE on Postgres, where `_` and `%`
 * are wildcards: unescaped, `j_hn@outlook.com` finds `john@outlook.com`. So the
 * value is escaped first, which is exact under ILIKE. An engine that compiles the
 * same filter to `LOWER(col) = LOWER($1)` would never match the escaped form of a
 * value that really contains `_` or `%`, so only then is the raw value tried once.
 * Every row is compared in code before it is returned, so neither query can hand
 * back a different account: under ILIKE the escaped query already found any exact
 * row, and under LOWER the raw query is the exact one.
 */
async function findUserInsensitive(
  db: PrismaModelAccess,
  fields: ReadonlyArray<'email' | 'username'>,
  value: string
): Promise<AuthUser | null> {
  const query = (equals: string) => {
    const clauses = fields.map((field) => ({ [field]: { equals, mode: 'insensitive' } }));
    return db.user.findFirst({
      where: clauses.length === 1 ? clauses[0] : { OR: clauses },
    }) as Promise<AuthUser | null>;
  };
  const exact = (row: AuthUser | null) =>
    row && fields.some((field) => sameIdentifier(row[field], value)) ? row : null;

  const escaped = exact(await query(escapeLikePattern(value)));
  if (escaped || !hasLikeWildcard(value)) return escaped;
  return exact(await query(value));
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
      // `mode: 'insensitive'` equals is ILIKE on Postgres, so the value is escaped
      // (utilities/emailMatch.ts) and the row is re-checked before it is returned.
      async findByEmailInsensitive(email: string): Promise<AuthUser | null> {
        return findUserInsensitive(db, ['email'], email);
      },

      async findByUsernameInsensitive(username: string): Promise<AuthUser | null> {
        return findUserInsensitive(db, ['username'], username);
      },

      // One OR over both columns, escaped and re-checked like the single-column
      // lookups, so a row matches only when its email or its username is exact.
      async findByEmailOrUsernameInsensitive(identifier: string): Promise<AuthUser | null> {
        return findUserInsensitive(db, ['email', 'username'], identifier);
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

      async setTwoFaSecret(id: number, secret: string, backupCodes: string[]): Promise<void> {
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
          data: { twoFaSecret: null, twoFaBackupCodes: [] },
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
          const next = [
            ...row.twoFaBackupCodes.slice(0, idx),
            ...row.twoFaBackupCodes.slice(idx + 1),
          ];
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
          const next = [
            ...row.twoFaBackupCodes.slice(0, idx),
            ...row.twoFaBackupCodes.slice(idx + 1),
          ];
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

      async findManyByIds(ids: number[]): Promise<SessionWithUser[]> {
        if (ids.length === 0) return [];
        const rows = await db.session.findMany({
          where: { id: { in: ids } },
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
        return rows as SessionWithUser[];
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

            async consume(id: string): Promise<boolean> {
              const now = new Date();
              // Conditional on still being unused, so of two racers only one
              // update touches a row.
              const { count } = (await db.magicLink!.updateMany({
                where: { id, usedAt: null, expiresAt: { gt: now } },
                data: { usedAt: now },
              })) as { count: number };
              return count === 1;
            },
          },
        }
      : {}),

    // Only populated when the consumer's Prisma schema includes EmailLoginAttempt
    ...(db.emailLoginAttempt
      ? {
          emailLoginAttempt: {
            async create(data: CreateEmailLoginAttemptData): Promise<AuthEmailLoginAttempt> {
              return db.emailLoginAttempt!.create({ data }) as Promise<AuthEmailLoginAttempt>;
            },

            async findByTokenHash(tokenHash: string): Promise<AuthEmailLoginAttempt | null> {
              return db.emailLoginAttempt!.findUnique({
                where: { tokenHash },
              }) as Promise<AuthEmailLoginAttempt | null>;
            },

            async findLatestOpenByEmail(email: string): Promise<AuthEmailLoginAttempt | null> {
              return db.emailLoginAttempt!.findFirst({
                where: { email, consumedAt: null, expiresAt: { gt: new Date() } },
                orderBy: { createdAt: 'desc' },
              }) as Promise<AuthEmailLoginAttempt | null>;
            },

            async consume(id: string): Promise<boolean> {
              const now = new Date();
              // Conditional on still being open, so of two racers only one update
              // touches a row.
              const { count } = (await db.emailLoginAttempt!.updateMany({
                where: { id, consumedAt: null, expiresAt: { gt: now } },
                data: { consumedAt: now },
              })) as { count: number };
              return count === 1;
            },

            async incrementAttempts(id: string): Promise<number> {
              const row = (await db.emailLoginAttempt!.update({
                where: { id },
                data: { attempts: { increment: 1 } },
                select: { attempts: true },
              })) as { attempts: number };
              return row.attempts;
            },

            async consumeOpenByEmail(email: string): Promise<void> {
              await db.emailLoginAttempt!.updateMany({
                where: { email, consumedAt: null },
                data: { consumedAt: new Date() },
              });
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
      // `revokedAt: null` is load-bearing, not tidiness. Revoking a session sets
      // the column and leaves the row, so without this filter the TOTP secret of
      // a device the user deliberately revoked — an old phone, a sold one, "log
      // out everywhere" after a compromise — still answers the login challenge.
      // Revoking a device has to revoke its second factor with it.
      //
      // Safe only because `carryDeviceTwoFaSecret` moves the secret onto the
      // replacement session on every sign-in (utilities/issueCookies.ts). Without
      // that, this filter turns the leak into a lockout: an ordinary re-login
      // would leave the account with no live secret at all.
      async findTwoFaSecretsByUserId(userId: number): Promise<{ twoFaSecret: string | null }[]> {
        return db.session.findMany({
          where: { userId, twoFaSecret: { not: null }, revokedAt: null },
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

      async moveTwoFaSecret(
        userId: number,
        fromSessionId: number,
        toSessionId: number
      ): Promise<void> {
        const apply = async (client: PrismaModelAccess) => {
          const from = (await client.session.findUnique({
            where: { id: fromSessionId, userId },
            select: { twoFaSecret: true },
          })) as { twoFaSecret: string | null } | null;
          if (!from?.twoFaSecret) return;

          // Clear BEFORE writing, even inside the transaction. `twoFaSecret` is
          // `@unique` and Prisma does not declare the constraint DEFERRABLE, so
          // Postgres checks it per statement: the donor has to be empty before
          // the recipient can hold the string. Writing first fails outright, and
          // copying — which is what this method replaced — fails the same way.
          await client.session.updateMany({
            where: { id: fromSessionId, userId },
            data: { twoFaSecret: null },
          });
          await client.session.updateMany({
            where: { id: toSessionId, userId },
            data: { twoFaSecret: from.twoFaSecret },
          });
        };

        // Both writes or neither, so a crash cannot leave the secret on no row
        // at all. `$transaction` is optional on the client shape this adapter
        // accepts; without it the pair still runs in the fail-safe order.
        if (db.$transaction) {
          await db.$transaction((tx) => apply(tx as PrismaModelAccess));
          return;
        }
        await apply(db);
      },

      async findByIdWithDevice(id: number, userId: number): Promise<SessionWithDevice | null> {
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

      async upsertByPushToken(pushToken: string, sessionId: number, userId: number): Promise<void> {
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

      async findByUserAndToken(userId: number, pushToken: string): Promise<{ id: number } | null> {
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
