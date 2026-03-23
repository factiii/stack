import type { CreateHTTPContextOptions } from '@trpc/server/adapters/standalone';

import type { ResolvedAuthConfig } from './config';
import { setAuthCookie } from './cookies';
import { createAuthToken } from './jwt';

/**
 * Parameters for creating a session with a signed JWT token.
 */
export interface CreateSessionWithTokenParams {
  /** User ID to create the session for */
  userId: number;
  /** Browser name (from user-agent) */
  browserName: string;
  /** Socket ID for real-time connections */
  socketId: string | null;
  /** Device ID for push notifications */
  deviceId?: number;
  /** Extra fields to include in the session record (e.g., instanceId) */
  extraSessionData?: Record<string, unknown>;
}

/**
 * Result of creating a session with a token.
 */
export interface SessionWithTokenResult {
  /** Signed JWT access token */
  accessToken: string;
  /** Created session ID */
  sessionId: number;
}

/**
 * Create a session and sign a JWT token.
 *
 * Use this for programmatic auth flows (magic links, auto-login, test helpers)
 * where you need a token without going through the full login procedure.
 *
 * @param config - Resolved auth config (from createAuthConfig)
 * @param params - Session creation parameters
 * @returns Signed JWT and session ID
 */
export async function createSessionWithToken(
  config: ResolvedAuthConfig,
  params: CreateSessionWithTokenParams,
): Promise<SessionWithTokenResult> {
  const { userId, browserName, socketId, deviceId, extraSessionData } = params;

  const session = await config.database.session.create({
    userId,
    browserName,
    socketId,
    ...(deviceId != null ? { deviceId } : {}),
    ...extraSessionData,
  });

  const user = await config.database.user.findById(userId);

  const accessToken = createAuthToken(
    {
      id: session.id,
      userId: session.userId,
      verifiedHumanAt: user?.verifiedHumanAt ?? null,
    },
    {
      secret: config.secrets.jwt,
      expiresIn: config.tokenSettings.jwtExpiry,
    },
  );

  return { accessToken, sessionId: session.id };
}

/**
 * Create a session, sign a JWT token, and set the auth cookie on the response.
 *
 * Convenience wrapper around {@link createSessionWithToken} for HTTP handlers
 * that need to set the cookie immediately.
 *
 * @param config - Resolved auth config (from createAuthConfig)
 * @param params - Session creation parameters
 * @param res - HTTP response to set the cookie on
 * @returns Signed JWT and session ID
 */
export async function createSessionWithTokenAndCookie(
  config: ResolvedAuthConfig,
  params: CreateSessionWithTokenParams,
  res: CreateHTTPContextOptions['res'],
): Promise<SessionWithTokenResult> {
  const result = await createSessionWithToken(config, params);

  setAuthCookie(res, result.accessToken, config.cookieSettings, config.storageKeys);

  return result;
}
