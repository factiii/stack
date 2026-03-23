import { eq, and, or, isNull, isNotNull, gte, ne, sql } from 'drizzle-orm';
import type { AnyPgTable, PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import type {
  AuthOTP,
  AuthPasswordReset,
  AuthSession,
  AuthUser,
  CreateSessionData,
  CreateUserData,
  DatabaseAdapter,
  SessionWithDevice,
  SessionWithUser,
} from './database';

/**
 * A Postgres Drizzle table with column properties accessible by name.
 * Uses `Record<string, any>` intersection so that `PgTableWithColumns`
 * (which lacks a string index signature) can be assigned without error.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleTable = AnyPgTable & Record<string, any>;

/**
 * Drizzle table references required by the adapter.
 * Consumers pass their Drizzle Postgres table objects so the adapter
 * can build queries without knowing the schema file location.
 *
 * **Note:** This adapter only supports PostgreSQL via `drizzle-orm/pg-core`.
 */
export interface DrizzleAdapterTables {
  users: DrizzleTable;
  sessions: DrizzleTable;
  otps: DrizzleTable;
  passwordResets: DrizzleTable;
  devices: DrizzleTable;
  admins: DrizzleTable;
  /** Join table for many-to-many device↔user relation (if applicable). */
  devicesToUsers?: DrizzleTable;
  /** Join table for many-to-many device↔session relation (if applicable). */
  devicesToSessions?: DrizzleTable;
}

/**
 * Any `PgDatabase` instance, regardless of the underlying driver
 * (node-postgres, postgres.js, Neon, PGLite, etc.).
 */
type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Creates a DatabaseAdapter backed by Drizzle ORM.
 *
 * Usage:
 * ```ts
 * import { drizzle } from 'drizzle-orm/node-postgres';
 * import { createDrizzleAdapter } from '@factiii/auth/drizzle';
 * import * as schema from './schema';
 *
 * const db = drizzle(pool, { schema });
 * const adapter = createDrizzleAdapter(db, {
 *   users: schema.users,
 *   sessions: schema.sessions,
 *   otps: schema.otps,
 *   passwordResets: schema.passwordResets,
 *   devices: schema.devices,
 *   admins: schema.admins,
 * });
 * ```
 *
 * **Important:** This adapter uses Drizzle's relational query API (`db.query.*`)
 * for joins and `db.insert/update/delete` for mutations. Make sure your Drizzle
 * instance is created with `{ schema }` so relational queries work.
 */
export function createDrizzleAdapter(
  db: AnyPgDatabase,
  tables: DrizzleAdapterTables
): DatabaseAdapter {
  const { users, sessions, otps, passwordResets, devices, admins } = tables;

  return {
    user: {
      async findByEmailInsensitive(email: string): Promise<AuthUser | null> {
        const rows = await db
          .select()
          .from(users)
          .where(sql`lower(${users.email}) = lower(${email})`)
          .limit(1);
        return (rows[0] as unknown as AuthUser | undefined) ?? null;
      },

      async findByUsernameInsensitive(username: string): Promise<AuthUser | null> {
        const rows = await db
          .select()
          .from(users)
          .where(sql`lower(${users.username}) = lower(${username})`)
          .limit(1);
        return (rows[0] as unknown as AuthUser | undefined) ?? null;
      },

      async findByEmailOrUsernameInsensitive(identifier: string): Promise<AuthUser | null> {
        const rows = await db
          .select()
          .from(users)
          .where(
            or(
              sql`lower(${users.email}) = lower(${identifier})`,
              sql`lower(${users.username}) = lower(${identifier})`
            )
          )
          .limit(1);
        return (rows[0] as unknown as AuthUser | undefined) ?? null;
      },

      async findByEmailOrOAuthId(email: string, oauthId: string): Promise<AuthUser | null> {
        const rows = await db
          .select()
          .from(users)
          .where(
            or(
              sql`lower(${users.email}) = lower(${email})`,
              eq(users.oauthId, oauthId)
            )
          )
          .limit(1);
        return (rows[0] as unknown as AuthUser | undefined) ?? null;
      },

      async findById(id: number): Promise<AuthUser | null> {
        const rows = await db
          .select()
          .from(users)
          .where(eq(users.id, id))
          .limit(1);
        return (rows[0] as unknown as AuthUser | undefined) ?? null;
      },

      async findActiveById(id: number): Promise<AuthUser | null> {
        const rows = await db
          .select()
          .from(users)
          .where(and(eq(users.id, id), eq(users.status, 'ACTIVE')))
          .limit(1);
        return (rows[0] as unknown as AuthUser | undefined) ?? null;
      },

      async create(data: CreateUserData): Promise<AuthUser> {
        const rows = await db.insert(users).values(data as unknown as Record<string, unknown>).returning();
        return rows[0] as unknown as AuthUser;
      },

      async update(id: number, data: Partial<Omit<AuthUser, 'id'>>): Promise<AuthUser> {
        const rows = await db
          .update(users)
          .set(data as unknown as Record<string, unknown>)
          .where(eq(users.id, id))
          .returning();
        return rows[0] as unknown as AuthUser;
      },
    },

    session: {
      async findById(id: number): Promise<SessionWithUser | null> {
        const rows = await db
          .select({
            id: sessions.id,
            userId: sessions.userId,
            socketId: sessions.socketId,
            twoFaSecret: sessions.twoFaSecret,
            browserName: sessions.browserName,
            issuedAt: sessions.issuedAt,
            lastUsed: sessions.lastUsed,
            revokedAt: sessions.revokedAt,
            deviceId: sessions.deviceId,
            user: {
              status: users.status,
              verifiedHumanAt: users.verifiedHumanAt,
            },
          })
          .from(sessions)
          .innerJoin(users, eq(sessions.userId, users.id))
          .where(eq(sessions.id, id))
          .limit(1);
        return (rows[0] as unknown as SessionWithUser | undefined) ?? null;
      },

      async create(data: CreateSessionData): Promise<AuthSession> {
        const rows = await db.insert(sessions).values(data as unknown as Record<string, unknown>).returning();
        return rows[0] as unknown as AuthSession;
      },

      async update(
        id: number,
        data: Partial<Pick<AuthSession, 'revokedAt' | 'lastUsed' | 'twoFaSecret' | 'deviceId'>>
      ): Promise<AuthSession> {
        const rows = await db
          .update(sessions)
          .set(data as unknown as Record<string, unknown>)
          .where(eq(sessions.id, id))
          .returning();
        return rows[0] as unknown as AuthSession;
      },

      async updateLastUsed(
        id: number
      ): Promise<AuthSession & { user: { verifiedHumanAt: Date | null } }> {
        // Update session
        await db
          .update(sessions)
          .set({ lastUsed: new Date() })
          .where(eq(sessions.id, id));

        // Fetch session with user join
        const rows = await db
          .select({
            id: sessions.id,
            userId: sessions.userId,
            socketId: sessions.socketId,
            twoFaSecret: sessions.twoFaSecret,
            browserName: sessions.browserName,
            issuedAt: sessions.issuedAt,
            lastUsed: sessions.lastUsed,
            revokedAt: sessions.revokedAt,
            deviceId: sessions.deviceId,
            user: {
              verifiedHumanAt: users.verifiedHumanAt,
            },
          })
          .from(sessions)
          .innerJoin(users, eq(sessions.userId, users.id))
          .where(eq(sessions.id, id))
          .limit(1);

        return rows[0] as unknown as AuthSession & { user: { verifiedHumanAt: Date | null } };
      },

      async revoke(id: number): Promise<void> {
        await db
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(eq(sessions.id, id));
      },

      async findActiveByUserId(
        userId: number,
        excludeSessionId?: number
      ): Promise<Pick<AuthSession, 'id' | 'socketId' | 'userId'>[]> {
        const conditions = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
        if (excludeSessionId !== undefined) {
          conditions.push(ne(sessions.id, excludeSessionId));
        }

        const activeRows = await db
          .select({
            id: sessions.id,
            socketId: sessions.socketId,
            userId: sessions.userId,
          })
          .from(sessions)
          .where(and(...conditions));
        return activeRows as Pick<AuthSession, 'id' | 'socketId' | 'userId'>[];
      },

      async revokeAllByUserId(userId: number, excludeSessionId?: number): Promise<void> {
        const conditions = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
        if (excludeSessionId !== undefined) {
          conditions.push(ne(sessions.id, excludeSessionId));
        }

        await db
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(and(...conditions));
      },

      async findTwoFaSecretsByUserId(
        userId: number
      ): Promise<{ twoFaSecret: string | null }[]> {
        const secretRows = await db
          .select({ twoFaSecret: sessions.twoFaSecret })
          .from(sessions)
          .where(and(eq(sessions.userId, userId), isNotNull(sessions.twoFaSecret)));
        return secretRows as { twoFaSecret: string | null }[];
      },

      async clearTwoFaSecrets(userId: number, excludeSessionId?: number): Promise<void> {
        const conditions = [eq(sessions.userId, userId)];
        if (excludeSessionId !== undefined) {
          conditions.push(ne(sessions.id, excludeSessionId));
        }

        await db
          .update(sessions)
          .set({ twoFaSecret: null })
          .where(and(...conditions));
      },

      async findByIdWithDevice(
        id: number,
        userId: number
      ): Promise<SessionWithDevice | null> {
        const rows = await db
          .select({
            twoFaSecret: sessions.twoFaSecret,
            deviceId: sessions.deviceId,
            device: {
              pushToken: devices.pushToken,
            },
          })
          .from(sessions)
          .leftJoin(devices, eq(sessions.deviceId, devices.id))
          .where(and(eq(sessions.id, id), eq(sessions.userId, userId)))
          .limit(1);

        if (!rows[0]) return null;

        const row = rows[0] as Record<string, unknown>;
        const device = row.device as { pushToken?: string } | null;
        return {
          twoFaSecret: row.twoFaSecret as string | null,
          deviceId: row.deviceId as number | null,
          device: device?.pushToken ? { pushToken: device.pushToken } : null,
        };
      },

      async revokeByDevicePushToken(
        userId: number,
        pushToken: string,
        excludeSessionId: number
      ): Promise<void> {
        // Find device by pushToken, then revoke matching sessions
        const deviceRows = await db
          .select({ id: devices.id })
          .from(devices)
          .where(eq(devices.pushToken, pushToken))
          .limit(1) as { id: number }[];

        if (!deviceRows[0]) return;

        await db
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(sessions.userId, userId),
              ne(sessions.id, excludeSessionId),
              isNull(sessions.revokedAt),
              eq(sessions.deviceId, deviceRows[0].id)
            )
          );
      },

      async clearDeviceId(userId: number, deviceId: number): Promise<void> {
        await db
          .update(sessions)
          .set({ deviceId: null })
          .where(and(eq(sessions.userId, userId), eq(sessions.deviceId, deviceId)));
      },
    },

    otp: {
      async findValidByUserAndCode(userId: number, code: number): Promise<AuthOTP | null> {
        const rows = await db
          .select()
          .from(otps)
          .where(
            and(eq(otps.userId, userId), eq(otps.code, code), gte(otps.expiresAt, new Date()))
          )
          .limit(1);
        return (rows[0] as unknown as AuthOTP | undefined) ?? null;
      },

      async create(data: { userId: number; code: number; expiresAt: Date }): Promise<AuthOTP> {
        const rows = await db.insert(otps).values(data as unknown as Record<string, unknown>).returning();
        return rows[0] as unknown as AuthOTP;
      },

      async delete(id: number): Promise<void> {
        await db.delete(otps).where(eq(otps.id, id));
      },
    },

    passwordReset: {
      async findById(id: string): Promise<AuthPasswordReset | null> {
        const rows = await db
          .select({
            id: passwordResets.id,
            createdAt: passwordResets.createdAt,
            userId: passwordResets.userId,
          })
          .from(passwordResets)
          .where(eq(passwordResets.id, id))
          .limit(1);
        return (rows[0] as unknown as AuthPasswordReset | undefined) ?? null;
      },

      async create(userId: number): Promise<AuthPasswordReset> {
        const rows = await db
          .insert(passwordResets)
          .values({ userId })
          .returning();
        return rows[0] as unknown as AuthPasswordReset;
      },

      async delete(id: string): Promise<void> {
        await db.delete(passwordResets).where(eq(passwordResets.id, id));
      },

      async deleteAllByUserId(userId: number): Promise<void> {
        await db.delete(passwordResets).where(eq(passwordResets.userId, userId));
      },
    },

    device: {
      async findByTokenSessionAndUser(
        pushToken: string,
        sessionId: number,
        userId: number
      ): Promise<{ id: number } | null> {
        // With Drizzle, many-to-many requires querying through join tables.
        // This assumes the consumer's schema has the appropriate relations set up.
        // We query devices and check for matching session and user via subqueries.
        const rows = await db
          .select({ id: devices.id })
          .from(devices)
          .where(eq(devices.pushToken, pushToken))
          .limit(1) as { id: number }[];

        if (!rows[0]) return null;

        // Verify the device is connected to the session and user via join tables
        if (tables.devicesToSessions && tables.devicesToUsers) {
          const sessionLink = await db
            .select()
            .from(tables.devicesToSessions)
            .where(
              and(
                eq(tables.devicesToSessions.deviceId, rows[0].id),
                eq(tables.devicesToSessions.sessionId, sessionId)
              )
            )
            .limit(1);

          const userLink = await db
            .select()
            .from(tables.devicesToUsers)
            .where(
              and(
                eq(tables.devicesToUsers.deviceId, rows[0].id),
                eq(tables.devicesToUsers.userId, userId)
              )
            )
            .limit(1);

          if (!sessionLink[0] || !userLink[0]) return null;
        }

        return { id: rows[0].id };
      },

      async upsertByPushToken(
        pushToken: string,
        sessionId: number,
        userId: number
      ): Promise<void> {
        // Check if device exists
        const existing = await db
          .select({ id: devices.id })
          .from(devices)
          .where(eq(devices.pushToken, pushToken))
          .limit(1) as { id: number }[];

        let deviceId: number;

        if (existing[0]) {
          deviceId = existing[0].id;
        } else {
          const insertedRows = await db
            .insert(devices)
            .values({ pushToken })
            .returning({ id: devices.id }) as { id: number }[];
          deviceId = insertedRows[0].id;
        }

        // Connect session and user via join tables (if using explicit join tables)
        if (tables.devicesToSessions) {
          await db
            .insert(tables.devicesToSessions)
            .values({ deviceId, sessionId })
            .onConflictDoNothing();
        }
        if (tables.devicesToUsers) {
          await db
            .insert(tables.devicesToUsers)
            .values({ deviceId, userId })
            .onConflictDoNothing();
        }

        // Also set deviceId on the session directly
        await db
          .update(sessions)
          .set({ deviceId })
          .where(eq(sessions.id, sessionId));
      },

      async findByUserAndToken(
        userId: number,
        pushToken: string
      ): Promise<{ id: number } | null> {
        if (tables.devicesToUsers) {
          const joinRows = await db
            .select({ id: devices.id })
            .from(devices)
            .innerJoin(
              tables.devicesToUsers,
              eq(devices.id, tables.devicesToUsers.deviceId)
            )
            .where(
              and(
                eq(devices.pushToken, pushToken),
                eq(tables.devicesToUsers.userId, userId)
              )
            )
            .limit(1) as { id: number }[];
          return joinRows[0] ? { id: joinRows[0].id } : null;
        }

        // Fallback: just find by pushToken
        const rows = await db
          .select({ id: devices.id })
          .from(devices)
          .where(eq(devices.pushToken, pushToken))
          .limit(1) as { id: number }[];
        return rows[0] ? { id: rows[0].id } : null;
      },

      async disconnectUser(deviceId: number, userId: number): Promise<void> {
        if (tables.devicesToUsers) {
          await db
            .delete(tables.devicesToUsers)
            .where(
              and(
                eq(tables.devicesToUsers.deviceId, deviceId),
                eq(tables.devicesToUsers.userId, userId)
              )
            );
        }
      },

      async hasRemainingUsers(deviceId: number): Promise<boolean> {
        if (tables.devicesToUsers) {
          const remainingRows = await db
            .select({ userId: tables.devicesToUsers.userId })
            .from(tables.devicesToUsers)
            .where(eq(tables.devicesToUsers.deviceId, deviceId))
            .limit(1);
          return remainingRows.length > 0;
        }
        return false;
      },

      async delete(id: number): Promise<void> {
        await db.delete(devices).where(eq(devices.id, id));
      },
    },

    admin: {
      async findByUserId(userId: number): Promise<{ ip: string } | null> {
        const rows = await db
          .select({ ip: admins.ip })
          .from(admins)
          .where(eq(admins.userId, userId))
          .limit(1);
        return (rows[0] as { ip: string } | undefined) ?? null;
      },
    },
  };
}
