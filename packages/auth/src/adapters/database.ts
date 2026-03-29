/**
 * ORM-agnostic database adapter interface for @factiii/auth.
 * Implement this interface to use any database/ORM with the auth library.
 */

// ── Auth model types (ORM-agnostic) ──────────────────────────────────────────

export interface AuthUser {
  id: number;
  status: string;
  email: string;
  username: string;
  password: string | null;
  twoFaEnabled: boolean;
  oauthProvider: string | null;
  oauthId: string | null;
  tag: string;
  verifiedHumanAt: Date | null;
  emailVerificationStatus: string;
  otpForEmailVerification: string | null;
  isActive: boolean;
  updatedAt: Date;
}

export interface AuthSession {
  id: number;
  userId: number;
  socketId: string | null;
  twoFaSecret: string | null;
  browserName: string;
  issuedAt: Date;
  lastUsed: Date;
  revokedAt: Date | null;
  deviceId: number | null;
}

export interface AuthOTP {
  id: number;
  code: number;
  expiresAt: Date;
  userId: number;
}

export interface AuthPasswordReset {
  id: string;
  createdAt: Date;
  userId: number;
}

export interface AuthMagicLink {
  id: string;
  expiresAt: Date;
  usedAt: Date | null;
  userId: number;
}

// ── Input types ──────────────────────────────────────────────────────────────

export interface CreateUserData {
  username: string;
  email: string;
  password: string | null;
  status: string;
  tag: string;
  twoFaEnabled: boolean;
  emailVerificationStatus: string;
  verifiedHumanAt: Date | null;
  oauthProvider?: string;
  oauthId?: string;
}

export interface CreateSessionData {
  userId: number;
  browserName: string;
  socketId: string | null;
  [key: string]: unknown;
}

// ── Composite return types ───────────────────────────────────────────────────

export type SessionWithUser = AuthSession & {
  user: { status: string; verifiedHumanAt: Date | null; updatedAt: Date };
};

export type SessionWithDevice = {
  twoFaSecret: string | null;
  deviceId: number | null;
  device: { pushToken: string } | null;
};

// ── Database adapter interface ───────────────────────────────────────────────

export interface DatabaseAdapter {
  user: {
    findByEmailInsensitive(email: string): Promise<AuthUser | null>;
    findByUsernameInsensitive(username: string): Promise<AuthUser | null>;
    findByEmailOrUsernameInsensitive(identifier: string): Promise<AuthUser | null>;
    findByEmailOrOAuthId(email: string, oauthId: string): Promise<AuthUser | null>;
    findById(id: number): Promise<AuthUser | null>;
    findActiveById(id: number): Promise<AuthUser | null>;
    create(data: CreateUserData): Promise<AuthUser>;
    update(id: number, data: Partial<Omit<AuthUser, 'id'>>): Promise<AuthUser>;
  };

  session: {
    /** Find session by ID with user status and verifiedHumanAt joined. */
    findById(id: number): Promise<SessionWithUser | null>;
    create(data: CreateSessionData): Promise<AuthSession>;
    update(id: number, data: Partial<Pick<AuthSession, 'revokedAt' | 'lastUsed' | 'twoFaSecret' | 'deviceId'>>): Promise<AuthSession>;
    /** Update lastUsed and return session with user's verifiedHumanAt and updatedAt. */
    updateLastUsed(id: number): Promise<AuthSession & { user: { verifiedHumanAt: Date | null; updatedAt: Date } }>;
    /** Set revokedAt on a single session. */
    revoke(id: number): Promise<void>;
    /** Find active (non-revoked) sessions for a user, optionally excluding one. */
    findActiveByUserId(userId: number, excludeSessionId?: number): Promise<Pick<AuthSession, 'id' | 'socketId' | 'userId'>[]>;
    /** Revoke all active sessions for a user, optionally excluding one. */
    revokeAllByUserId(userId: number, excludeSessionId?: number): Promise<void>;
    /** Get twoFaSecret from all sessions that have one for a user. */
    findTwoFaSecretsByUserId(userId: number): Promise<{ twoFaSecret: string | null }[]>;
    /** Clear twoFaSecret on sessions for a user, optionally excluding one. */
    clearTwoFaSecrets(userId: number, excludeSessionId?: number): Promise<void>;
    /** Find session with device relation for TOTP verification. */
    findByIdWithDevice(id: number, userId: number): Promise<SessionWithDevice | null>;
    /** Revoke other sessions that share a device push token. */
    revokeByDevicePushToken(userId: number, pushToken: string, excludeSessionId: number): Promise<void>;
    /** Clear deviceId on all sessions for a user+device pair. */
    clearDeviceId(userId: number, deviceId: number): Promise<void>;
  };

  otp: {
    findValidByUserAndCode(userId: number, code: number): Promise<AuthOTP | null>;
    create(data: { userId: number; code: number; expiresAt: Date }): Promise<AuthOTP>;
    delete(id: number): Promise<void>;
  };

  passwordReset: {
    findById(id: string): Promise<AuthPasswordReset | null>;
    create(userId: number): Promise<AuthPasswordReset>;
    delete(id: string): Promise<void>;
    deleteAllByUserId(userId: number): Promise<void>;
  };

  device: {
    findByTokenSessionAndUser(pushToken: string, sessionId: number, userId: number): Promise<{ id: number } | null>;
    upsertByPushToken(pushToken: string, sessionId: number, userId: number): Promise<void>;
    findByUserAndToken(userId: number, pushToken: string): Promise<{ id: number } | null>;
    disconnectUser(deviceId: number, userId: number): Promise<void>;
    hasRemainingUsers(deviceId: number): Promise<boolean>;
    delete(id: number): Promise<void>;
  };

  admin: {
    findByUserId(userId: number): Promise<{ ip: string } | null>;
  };

  /** Optional — required only when features.magicLink is enabled. */
  magicLink?: {
    findById(id: string): Promise<AuthMagicLink | null>;
    create(data: { userId: number; expiresAt: Date }): Promise<AuthMagicLink>;
    markUsed(id: string): Promise<AuthMagicLink>;
  };
}
