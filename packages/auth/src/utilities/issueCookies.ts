import { TRPCError } from '@trpc/server';
import type { CreateHTTPContextOptions } from '@trpc/server/adapters/standalone';

import type { ClientCookiePayload } from '../types';
import type { ResolvedAuthConfig } from './config';
import { parseAuthCookie, setAuthCookies } from './cookies';
import {
  createAuthToken,
  isTokenExpiredError,
  isTokenInvalidError,
  verifyAuthToken,
} from './jwt';

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
