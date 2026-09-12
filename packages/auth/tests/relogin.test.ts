import { describe, it, expect, vi } from 'vitest';

import {
  carryDeviceTwoFaSecret,
  revokeDeviceSessionsForUser,
} from '../src/utilities/issueCookies';
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

/**
 * In device mode the TOTP secret sits on `Session.twoFaSecret`, but it belongs
 * to the phone, not to any one session of it. Nothing used to move it when a
 * sign-in replaced the session holding it, which was survivable only because
 * `findTwoFaSecretsByUserId` did not filter revoked rows — a hole, since a
 * revoked device's secret still answered the login challenge. Closing that hole
 * alone would turn the leak into a lockout, so these pin the carry that makes it
 * safe. If they fail, do not "fix" them by relaxing the adapter filter.
 *
 * The fake below enforces the `@unique` constraint the real schema declares on
 * `Session.twoFaSecret`, because the first version of this code COPIED the secret
 * and every mocked test passed: a mock that cannot fail the way production fails
 * proves nothing. Two rows must never hold the same string, so the secret is
 * moved — the donor gives it up in the same step the recipient takes it.
 */
describe('carryDeviceTwoFaSecret', () => {
  /**
   * An in-memory sessions table with the unique index on `twoFaSecret`.
   * `withMove: false` models an adapter written before `moveTwoFaSecret` existed,
   * which is the fallback path inside the helper.
   */
  function buildDeviceConfig(
    secretsBySession: Record<number, string | null>,
    opts: { twoFaMode?: 'device' | 'standard'; withMove?: boolean } = {}
  ) {
    const { twoFaMode = 'device', withMove = true } = opts;
    const rows: Record<number, string | null> = { ...secretsBySession };
    const writes: Array<{ id: number; secret: string | null }> = [];

    const write = (id: number, secret: string | null) => {
      if (secret !== null) {
        const holder = Object.entries(rows).find(
          ([otherId, value]) => value === secret && Number(otherId) !== id
        );
        if (holder) {
          // What Postgres says, near enough, when a second row reaches for a
          // string another row already holds.
          throw new Error(
            'Unique constraint failed on the fields: ("twoFaSecret")'
          );
        }
      }
      rows[id] = secret;
      writes.push({ id, secret });
    };

    const setTwoFaSecret = vi.fn(async (id: number, secret: string | null) => {
      write(id, secret);
    });

    const moveTwoFaSecret = vi.fn(
      async (_userId: number, fromId: number, toId: number) => {
        const secret = rows[fromId];
        if (!secret) return;
        // Clear before write, exactly as both shipped adapters do.
        write(fromId, null);
        write(toId, secret);
      }
    );

    const findByIdWithDevice = vi.fn(async (id: number) =>
      id in rows ? { twoFaSecret: rows[id], deviceId: null, device: null } : null
    );

    const session: Record<string, unknown> = {
      findByIdWithDevice,
      setTwoFaSecret,
      ...(withMove ? { moveTwoFaSecret } : {}),
    };

    const config = {
      features: { twoFaMode },
      deviceAuth: { session },
    } as unknown as ResolvedAuthConfig;

    return { config, rows, writes, setTwoFaSecret, moveTwoFaSecret, findByIdWithDevice };
  }

  it('moves the secret to the replacement and leaves it on no other row', async () => {
    const { config, rows } = buildDeviceConfig({ 10: 'SECRET-A' });

    await carryDeviceTwoFaSecret(config, {
      userId: 1,
      revokedSessionIds: [10],
      newSessionId: 20,
    });

    expect(rows[20]).toBe('SECRET-A');
    // The retired row must NOT still hold it. Under the real unique index it
    // cannot, which is the whole reason this is a move.
    expect(rows[10]).toBeNull();
  });

  it('does not trip the unique index it used to trip', async () => {
    // The regression. Copying threw here, the helper swallowed it, and the
    // replacement session ended up with no second factor at all.
    const { config, rows } = buildDeviceConfig({ 10: 'SECRET-A' });

    await carryDeviceTwoFaSecret(config, {
      userId: 1,
      revokedSessionIds: [10],
      newSessionId: 20,
    });

    expect(rows[20]).toBe('SECRET-A');
  });

  it('takes the first secret it finds when several sessions were retired', async () => {
    // Each is a secret this device's vault has been using; they are
    // alternatives, not a set to merge.
    const { config, rows } = buildDeviceConfig({
      10: null,
      11: 'SECRET-B',
      12: 'SECRET-C',
    });

    await carryDeviceTwoFaSecret(config, {
      userId: 1,
      revokedSessionIds: [10, 11, 12],
      newSessionId: 20,
    });

    expect(rows[20]).toBe('SECRET-B');
    expect(rows[11]).toBeNull();
    expect(rows[12]).toBe('SECRET-C');
  });

  it('clears the donor before writing the recipient, without moveTwoFaSecret', async () => {
    // An adapter from before the method existed. Not atomic, so the ORDER is the
    // safety: the worst case has to be a secret on neither row, never a write
    // that throws against the unique index and changes nothing.
    const { config, rows, writes } = buildDeviceConfig(
      { 10: 'SECRET-A' },
      { withMove: false }
    );

    await carryDeviceTwoFaSecret(config, {
      userId: 1,
      revokedSessionIds: [10],
      newSessionId: 20,
    });

    expect(writes).toEqual([
      { id: 10, secret: null },
      { id: 20, secret: 'SECRET-A' },
    ]);
    expect(rows[20]).toBe('SECRET-A');
    expect(rows[10]).toBeNull();
  });

  it('writes nothing when the retired sessions held no secret', async () => {
    const { config, writes } = buildDeviceConfig({ 10: null });

    await carryDeviceTwoFaSecret(config, {
      userId: 1,
      revokedSessionIds: [10],
      newSessionId: 20,
    });

    expect(writes).toEqual([]);
  });

  it('is a no-op on a first-time sign-in, where nothing was replaced', async () => {
    const { config, findByIdWithDevice } = buildDeviceConfig({ 10: 'SECRET-A' });

    await carryDeviceTwoFaSecret(config, {
      userId: 1,
      revokedSessionIds: [],
      newSessionId: 20,
    });

    expect(findByIdWithDevice).not.toHaveBeenCalled();
  });

  it('is a no-op in standard mode, where the secret lives on the user', async () => {
    // There is no session column to write, so touching one would be a bug.
    const { config, findByIdWithDevice, writes } = buildDeviceConfig(
      { 10: 'SECRET-A' },
      { twoFaMode: 'standard' }
    );

    await carryDeviceTwoFaSecret(config, {
      userId: 1,
      revokedSessionIds: [10],
      newSessionId: 20,
    });

    expect(findByIdWithDevice).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('never fails a sign-in that has already been approved', async () => {
    // Losing the cached second factor is recoverable — the vault can mint a new
    // one. Throwing here would reject a login whose credentials already passed.
    // It reports the failure rather than swallowing it in silence, which is how
    // the copy bug survived a review and 196 green tests.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = {
      features: { twoFaMode: 'device' },
      deviceAuth: {
        session: {
          findByIdWithDevice: vi.fn(async () => {
            throw new Error('database went away');
          }),
          setTwoFaSecret: vi.fn(async () => {}),
        },
      },
    } as unknown as ResolvedAuthConfig;

    await expect(
      carryDeviceTwoFaSecret(config, {
        userId: 1,
        revokedSessionIds: [10],
        newSessionId: 20,
      })
    ).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
