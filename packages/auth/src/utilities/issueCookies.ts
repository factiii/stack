import { TRPCError } from '@trpc/server';
import type { CreateHTTPContextOptions } from '@trpc/server/adapters/standalone';

import type { ClientCookiePayload } from '../types';
import type { ResolvedAuthConfig } from './config';
import { parseAuthCookie, setAuthCookies } from './cookies';
import { createAuthToken, isTokenExpiredError, isTokenInvalidError, verifyAuthToken } from './jwt';

interface IssueCookiesParams {
  ctx: { headers: { cookie?: string }; res: CreateHTTPContextOptions['res'] };
  /** Newly created session that should become the active one. */
  session: { id: number; userId: number };
  /** Drives the client cookie's updatedAt. */
  updatedAt: Date;
  /** Active user's verifiedHumanAt, baked into the JWT for biometric flows. */
  verifiedHumanAt?: Date | null;
}

/**
 * Issue auth cookies after sign-in / sign-up / oauth / magic-link.
 * Appends the new session to the existing bundle (capped by config.maxAccounts).
 */
export async function issueAuthCookies(
  config: ResolvedAuthConfig,
  params: IssueCookiesParams
): Promise<void> {
  const { ctx, session, updatedAt, verifiedHumanAt } = params;

  const clientPayload: ClientCookiePayload = {
    userId: session.userId,
    updatedAt: updatedAt.toISOString(),
  };
  if (config.getClientCookiePayload) {
    const extra = await config.getClientCookiePayload(session.userId);
    Object.assign(clientPayload, extra);
  }

  const existing = readExistingBundle(ctx.headers.cookie, config);
  const dedupedExisting = (existing ?? []).filter((id) => id !== session.id);

  // At maxAccounts=1, new login always replaces the existing slot.
  const carried = config.maxAccounts <= 1 ? [] : dedupedExisting;

  if (carried.length + 1 > config.maxAccounts) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Maximum of ${config.maxAccounts} accounts on this device. Remove an account first.`,
    });
  }

  let validatedExisting: number[] = carried;
  if (carried.length > 0) {
    const rows = await config.database.session.findManyByIds(carried);
    const validIds = new Set(rows.filter((r) => !r.revokedAt).map((r) => r.id));
    validatedExisting = carried.filter((id) => validIds.has(id));
  }

  const sessions = [...validatedExisting, session.id];
  const authToken = createAuthToken(
    { id: session.id, userId: session.userId, verifiedHumanAt: verifiedHumanAt ?? null, sessions },
    { secret: config.secrets.jwt, expiresIn: config.tokenSettings.jwtExpiry }
  );
  setAuthCookies(
    ctx.res,
    authToken,
    clientPayload,
    config.secrets.jwt,
    config.cookieSettings,
    config.storageKeys
  );
}

/** True if `userId` already owns a valid session in this device's bundle. */
export async function isUserInBundle(
  config: ResolvedAuthConfig,
  cookieHeader: string | undefined,
  userId: number
): Promise<boolean> {
  const existing = readExistingBundle(cookieHeader, config);
  if (!existing || existing.length === 0) return false;
  const rows = await config.database.session.findManyByIds(existing);
  return rows.some((r) => !r.revokedAt && r.userId === userId);
}

/**
 * Retire the sessions this device already holds for `userId`, so a fresh
 * sign-in can replace them.
 *
 * Sign-in paths call this where they used to throw "You are already signed in
 * as this account on this device." That throw fired *after* the password and
 * 2FA had both verified, which made it unrecoverable: no credential and no
 * TOTP code could get past it, and a client whose view of the session had
 * drifted from the cookie had no way back in short of clearing cookies. The
 * caller has proven who they are, so the correct answer is to re-issue, not to
 * refuse.
 *
 * Revoking rather than reusing the old session keeps `issueAuthCookies` honest:
 * at `maxAccounts: 1` it drops the previous bundle entry, so without this the
 * old row would linger un-revoked in the database, reachable by nothing.
 *
 * Returns the revoked session ids. Hook errors are swallowed per session — a
 * flaky `onSessionRevoked` listener must not leave the login half-done.
 */
export async function revokeDeviceSessionsForUser(
  config: ResolvedAuthConfig,
  cookieHeader: string | undefined,
  userId: number
): Promise<number[]> {
  const existing = readExistingBundle(cookieHeader, config);
  if (!existing || existing.length === 0) return [];

  const rows = await config.database.session.findManyByIds(existing);
  const revoked: number[] = [];

  for (const row of rows) {
    // Skip sessions belonging to other accounts in the bundle: at
    // maxAccounts > 1 they are bystanders and must survive this sign-in.
    if (row.revokedAt || row.userId !== userId) continue;

    await config.database.session.revoke(row.id);
    revoked.push(row.id);

    if (config.hooks?.onSessionRevoked) {
      try {
        await config.hooks.onSessionRevoked(
          row.id,
          row.socketId,
          'Replaced by a new sign-in on this device'
        );
      } catch {
        // Deliberately ignored — see the doc comment above.
      }
    }
  }

  return revoked;
}

/**
 * Move a device-mode TOTP secret from the sessions a sign-in just retired onto
 * the session that replaced them. Call it after creating the replacement, with
 * the ids `revokeDeviceSessionsForUser` returned.
 *
 * MOVE, not copy. `Session.twoFaSecret` is `@unique` in the reference schema, so
 * two rows may not hold the same string for an instant: writing the secret to the
 * replacement while the retired row still holds it throws a unique-constraint
 * error, and the first version of this function did exactly that and then
 * swallowed the error — leaving the replacement with nothing, which with the
 * revoked filter live is the lockout this function exists to prevent. The unit
 * tests missed it because a mocked adapter has no unique index, and the package's
 * own e2e schema had dropped the constraint. Any future change here must keep the
 * donor and the recipient from holding the string at the same time.
 *
 * In device mode the second factor lives on `Session.twoFaSecret`, but it
 * belongs to the *phone*, not to any one session of it — `enableTwofa` writes it
 * once and the vault caches it from there. Nothing carried it across a
 * replacement, so every ordinary sign-in left the device's live secret on a
 * revoked row and gave the replacement none. That was survivable only because
 * `findTwoFaSecretsByUserId` did not filter revoked rows, which is a hole:
 * a secret from a device the user deliberately revoked still answered the login
 * challenge. Closing that hole without this carry would turn the leak into a
 * lockout — after any re-login the user would have no live secret at all, and on
 * an account with no email on file, no way back in. The two changes are one
 * change; do not ship either alone.
 *
 * It also fixes something already broken: a consumer that filters revoked rows
 * itself (factiii's push-approval path does) finds nothing after a re-login, so
 * approvals fail until the vault happens to re-materialize a secret.
 *
 * Best effort by design. A failure here costs the device its cached second
 * factor — recoverable, since the vault can mint a new one — while throwing
 * would fail a sign-in whose credentials have already been accepted. It is not
 * SILENT, though: swallowing without a word is how the copy bug survived review
 * and every unit test, so a failure says so on the way past.
 */
export async function carryDeviceTwoFaSecret(
  config: ResolvedAuthConfig,
  params: { userId: number; revokedSessionIds: number[]; newSessionId: number }
): Promise<void> {
  const { userId, revokedSessionIds, newSessionId } = params;
  // Standard mode keeps the secret on the user row, where a session replacement
  // cannot touch it, so there is nothing to carry and no column to write.
  if (config.features.twoFaMode !== 'device') return;
  const deviceAuth = config.deviceAuth;
  if (!deviceAuth) return;
  if (revokedSessionIds.length === 0) return;

  try {
    for (const id of revokedSessionIds) {
      const row = await deviceAuth.session.findByIdWithDevice(id, userId);
      // First one wins. Several retired sessions can each hold a secret (one per
      // sign-in that enrolled), and any of them is a secret this device's vault
      // has been using — they are alternatives, not a set to merge.
      if (!row?.twoFaSecret) continue;

      if (deviceAuth.session.moveTwoFaSecret) {
        await deviceAuth.session.moveTwoFaSecret(userId, id, newSessionId);
        return;
      }
      // Fallback for an adapter written before `moveTwoFaSecret` existed. Not
      // atomic, so the order is the safety: clearing first means the worst case
      // is a secret on neither row, which the vault can re-mint. Writing first
      // would simply throw against a unique index and change nothing.
      await deviceAuth.session.setTwoFaSecret(id, null);
      await deviceAuth.session.setTwoFaSecret(newSessionId, row.twoFaSecret);
      return;
    }
  } catch (err) {
    // Never fail a sign-in whose credentials have already been accepted — but
    // never disappear either. This losing quietly is what cost a release.
    console.error(
      '[@factiii/auth] could not carry the device 2FA secret to the new session; ' +
        'the device must re-materialize one from its vault:',
      err
    );
  }
}

/** Returns session ids from the request cookie. */
function readExistingBundle(
  cookieHeader: string | undefined,
  config: ResolvedAuthConfig
): number[] | null {
  if (!cookieHeader) return null;
  const { authToken } = parseAuthCookie(cookieHeader, config.storageKeys);
  if (!authToken) return null;

  try {
    const payload = verifyAuthToken(authToken, {
      secret: config.secrets.jwt,
      ignoreExpiration: false,
    });
    return payload.sessions;
  } catch (err) {
    if (isTokenExpiredError(err) || isTokenInvalidError(err)) return null;
    return null;
  }
}
