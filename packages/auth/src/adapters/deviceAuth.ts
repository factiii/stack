/**
 * Device-mode 2FA adapter interface for @factiii/auth.
 *
 * This adapter is ONLY required when `features.twoFaMode === 'device'`.
 * Standard (user-centric TOTP) consumers do not need to implement this.
 *
 * The device flow stores a TOTP secret on each session and ties enrollment
 * to a registered mobile device's push token. See `procedures/twoFa/device.ts`.
 */

/**
 * Result of joining a session row with its (optional) device row.
 * Used by the device-mode `getTwofaSecret` procedure to verify the caller's
 * push code against the device's push token.
 */
export type SessionWithDevice = {
  twoFaSecret: string | null;
  deviceId: number | null;
  device: { pushToken: string } | null;
};

/**
 * Adapter contract for the device/push-token 2FA flow.
 *
 * Implementations must support:
 * - Per-session `twoFaSecret` columns on the sessions table
 * - A `devices` table keyed by `pushToken`
 * - A relation linking sessions ↔ devices and users ↔ devices
 *
 * See `prisma/schema.device.prisma` for the reference schema this targets.
 */
export interface DeviceAuthAdapter {
  session: {
    /** Get all non-null twoFaSecret values for a user (across all their sessions). */
    findTwoFaSecretsByUserId(userId: number): Promise<{ twoFaSecret: string | null }[]>;
    /** Clear `twoFaSecret` on a user's sessions, optionally excluding one. */
    clearTwoFaSecrets(userId: number, excludeSessionId?: number): Promise<void>;
    /** Set the `twoFaSecret` on a single session. */
    setTwoFaSecret(sessionId: number, secret: string | null): Promise<void>;
    /** Find a session with its (optional) device join, scoped to a user. */
    findByIdWithDevice(id: number, userId: number): Promise<SessionWithDevice | null>;
    /** Read just the deviceId from a session, scoped to a user. */
    getDeviceId(sessionId: number, userId: number): Promise<number | null>;
    /** Revoke other (non-current) sessions that share a given device push token. */
    revokeByDevicePushToken(
      userId: number,
      pushToken: string,
      excludeSessionId: number
    ): Promise<void>;
    /** Null out `deviceId` on every session for a user+device pair. */
    clearDeviceId(userId: number, deviceId: number): Promise<void>;
  };

  device: {
    /** Find a device by pushToken that is linked to BOTH the given session and user. */
    findByTokenSessionAndUser(
      pushToken: string,
      sessionId: number,
      userId: number
    ): Promise<{ id: number } | null>;
    /** Upsert a device by pushToken, linking it to the given session + user. */
    upsertByPushToken(pushToken: string, sessionId: number, userId: number): Promise<void>;
    /** Find a device by user + pushToken (no session constraint). */
    findByUserAndToken(userId: number, pushToken: string): Promise<{ id: number } | null>;
    /** Disconnect a single user from a device. */
    disconnectUser(deviceId: number, userId: number): Promise<void>;
    /** True if the device has any users still linked to it. */
    hasRemainingUsers(deviceId: number): Promise<boolean>;
    /** Permanently delete a device row. */
    delete(id: number): Promise<void>;
  };
}
