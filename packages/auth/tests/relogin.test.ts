import { describe, it, expect, vi } from 'vitest';

import { revokeDeviceSessionsForUser } from '../src/utilities/issueCookies';
import { createAuthToken } from '../src/utilities/jwt';
import type { ResolvedAuthConfig } from '../src/utilities/config';

const SECRET = 'test-secret-key';
const STORAGE_KEYS = { authToken: 'auth-token', clientToken: 'auth-client' };

/**
 * Sign-in used to throw BAD_REQUEST "You are already signed in as this account
 * on this device." *after* password and 2FA both verified, which made the state
 * unrecoverable — no credential and no TOTP code could get past it. These pin
 * the replacement: retire the device's stale sessions for that account and let
 * the sign-in proceed.
 */

type SessionRow = {
  id: number;
  userId: number;
  socketId: string | null;
  revokedAt: Date | null;
};

function buildConfig(
  rows: SessionRow[],
  onSessionRevoked?: ReturnType<typeof vi.fn>
) {
  const revoke = vi.fn(async (id: number) => {
    const row = rows.find((r) => r.id === id);
    if (row) row.revokedAt = new Date();
  });

  const config = {
    secrets: { jwt: SECRET },
    storageKeys: STORAGE_KEYS,
    maxAccounts: 1,
    database: {
      session: {
        findManyByIds: vi.fn(async (ids: number[]) =>
          rows.filter((r) => ids.includes(r.id))
        ),
        revoke,
      },
    },
    ...(onSessionRevoked ? { hooks: { onSessionRevoked } } : {}),
  } as unknown as ResolvedAuthConfig;

  return { config, revoke };
}

function cookieFor(sessions: number[]): string {
  const token = createAuthToken(
    { id: sessions[0], userId: 1, verifiedHumanAt: null, sessions },
    { secret: SECRET, expiresIn: '1h' }
  );
  return `${STORAGE_KEYS.authToken}=${token}`;
}

describe('revokeDeviceSessionsForUser', () => {
  it('revokes the stale session this device holds for the same account', async () => {
    const rows: SessionRow[] = [
      { id: 10, userId: 1, socketId: null, revokedAt: null },
    ];
    const { config, revoke } = buildConfig(rows);

    const revoked = await revokeDeviceSessionsForUser(config, cookieFor([10]), 1);

    expect(revoked).toEqual([10]);
    expect(revoke).toHaveBeenCalledWith(10);
    expect(rows[0].revokedAt).not.toBeNull();
  });

  it('leaves other accounts in the bundle alone', async () => {
    // At maxAccounts > 1 the bundle holds bystanders. Signing in as user 1
    // must not sign user 2 out of the same device.
    const rows: SessionRow[] = [
      { id: 10, userId: 1, socketId: null, revokedAt: null },
      { id: 11, userId: 2, socketId: null, revokedAt: null },
    ];
    const { config, revoke } = buildConfig(rows);

    const revoked = await revokeDeviceSessionsForUser(
      config,
      cookieFor([10, 11]),
      1
    );

    expect(revoked).toEqual([10]);
    expect(revoke).not.toHaveBeenCalledWith(11);
    expect(rows[1].revokedAt).toBeNull();
  });

  it('skips sessions already revoked by another path', async () => {
    // e.g. revokeAllByUserId fired from another device — re-revoking would
    // fire the hook a second time for one logout.
    const rows: SessionRow[] = [
      { id: 10, userId: 1, socketId: null, revokedAt: new Date() },
    ];
    const { config, revoke } = buildConfig(rows);

    const revoked = await revokeDeviceSessionsForUser(config, cookieFor([10]), 1);

    expect(revoked).toEqual([]);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('is a no-op with no cookie, so a first-time sign-in is untouched', async () => {
    const { config, revoke } = buildConfig([]);

    expect(await revokeDeviceSessionsForUser(config, undefined, 1)).toEqual([]);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('is a no-op when the cookie is not a valid token', async () => {
    const { config, revoke } = buildConfig([]);

    expect(
      await revokeDeviceSessionsForUser(config, 'auth-token=garbage', 1)
    ).toEqual([]);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('fires onSessionRevoked with the session id and socket', async () => {
    const rows: SessionRow[] = [
      { id: 10, userId: 1, socketId: 'sock-1', revokedAt: null },
    ];
    const onSessionRevoked = vi.fn();
    const { config } = buildConfig(rows, onSessionRevoked);

    await revokeDeviceSessionsForUser(config, cookieFor([10]), 1);

    expect(onSessionRevoked).toHaveBeenCalledWith(
      10,
      'sock-1',
      expect.stringContaining('Replaced by a new sign-in')
    );
  });

  it('still revokes when the hook throws', async () => {
    // A flaky listener must not abort a sign-in half-way.
    const rows: SessionRow[] = [
      { id: 10, userId: 1, socketId: null, revokedAt: null },
      { id: 11, userId: 1, socketId: null, revokedAt: null },
    ];
    const onSessionRevoked = vi.fn(() => {
      throw new Error('listener exploded');
    });
    const { config, revoke } = buildConfig(rows, onSessionRevoked);

    const revoked = await revokeDeviceSessionsForUser(
      config,
      cookieFor([10, 11]),
      1
    );

    expect(revoked).toEqual([10, 11]);
    expect(revoke).toHaveBeenCalledTimes(2);
  });
});
