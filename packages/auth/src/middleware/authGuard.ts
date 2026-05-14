import { TRPCError } from '@trpc/server';

import type { ClientCookiePayload } from '../types';
import { type AuthConfig } from '../types/config';
import { type TrpcBuilder, type TrpcContext } from '../types/trpc';
import type { DatabaseAdapter } from '../adapters/database';
import { createPrismaAdapter } from '../adapters/prismaAdapter';
import {
  defaultCookieSettings,
  defaultStorageKeys,
  defaultTokenSettings,
} from '../utilities/config';
import {
  clearAuthCookies,
  parseAuthCookie,
  parseClientCookie,
  parseClientCookiePayload,
  setAuthCookies,
  setClientCookie,
} from '../utilities/cookies';
import {
  createAuthToken,
  isTokenExpiredError,
  isTokenInvalidError,
  verifyAuthToken,
} from '../utilities/jwt';
import { truncateBundle } from '../utilities/bundle';

export function createAuthGuard(config: AuthConfig, t: TrpcBuilder) {
  const storageKeys = config.storageKeys ?? defaultStorageKeys;
  const cookieSettings = { ...defaultCookieSettings, ...config.cookieSettings };
  const tokenSettings = { ...defaultTokenSettings, ...config.tokenSettings };
  const maxAccounts = config.maxAccounts ?? 1;
  const SLIDE_THRESHOLD_SECONDS = 24 * 60 * 60; // 24 hours

  const database: DatabaseAdapter =
    config.database ??
    createPrismaAdapter(config.prisma);

  const revokeSession = async (
    ctx: TrpcContext,
    sessionId: number | null,
    description: string,
    errorStack?: string | null,
    path?: string
  ) => {
    clearAuthCookies(ctx.res, cookieSettings, storageKeys);

    // Log session revocations for security auditing
    if (config.hooks?.logError) {
      try {
        const cookieHeader = ctx.headers.cookie;
        const contextInfo = {
          reason: description,
          sessionId,
          userId: ctx.userId,
          ip: ctx.ip,
          userAgent: ctx.headers['user-agent'],
          ...(path ? { path } : {}),
          hasCookieHeader: Boolean(cookieHeader),
          cookieKeys: cookieHeader
            ? cookieHeader
                .split(';')
                .map((c) => c.trim().split('=')[0])
                .filter(Boolean)
            : [],
          origin: ctx.headers.origin ?? null,
          referer: ctx.headers.referer ?? null,
          timestamp: new Date().toISOString()
        };

        const combinedStack = [
          errorStack ? `Error Stack:\n${errorStack}` : null,
          'Context:',
          JSON.stringify(contextInfo, null, 2),
        ]
          .filter(Boolean)
          .join('\n\n');

        await config.hooks.logError({
          type: 'SECURITY',
          description: `Session revoked: ${description}`,
          stack: combinedStack,
          ip: ctx.ip,
          userId: ctx.userId ?? null,
        });
      } catch {
        // Silently fail - don't let error logging prevent session revocation
      }
    }

    if (sessionId) {
      try {
        await database.session.revoke(sessionId);

        if (config.hooks?.onSessionRevoked) {
          const session = await database.session.findById(sessionId);
          if (session) {
            await config.hooks.onSessionRevoked(session.userId, session.socketId, description);
          }
        }
      } catch {
        // Session may already be revoked or deleted
      }
    }
  };

  const authGuard = t.middleware(async ({ ctx, meta, next, path }) => {
    const cookies = parseAuthCookie(ctx.headers.cookie, storageKeys);
    const authToken = cookies.authToken;
    const userAgent = ctx.headers['user-agent'];

    if (!userAgent) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'User agent is required',
      });
    }

    if (authToken) {
      try {
        const payload = verifyAuthToken(authToken, {
          secret: config.secrets.jwt,
          ignoreExpiration: meta?.ignoreExpiration ?? false,
        });
        const { kept: requestedIds, dropped: droppedIds } = truncateBundle(
          payload.sessions,
          payload.id,
          maxAccounts,
        );
        for (const id of droppedIds) {
          await database.session.revoke(id).catch(() => {});
        }
        const session = await database.session.findById(payload.id);

        // Active session is gone — try promoting another from the bundle before failing.
        if (!session || session.revokedAt) {
          const remainingIds = requestedIds.filter((id) => id !== payload.id);
          const validRows = remainingIds.length
            ? (await database.session.findManyByIds(remainingIds)).filter((s) => !s.revokedAt)
            : [];

          if (validRows.length > 0) {
            const validIds = new Set(validRows.map((s) => s.id));
            const newActiveId = [...remainingIds].reverse().find((id) => validIds.has(id));
            const newActive = validRows.find((r) => r.id === newActiveId)!;
            const prunedIds = remainingIds.filter((id) => validIds.has(id));
            const newJwt = createAuthToken(
              {
                id: newActive.id,
                userId: newActive.userId,
                verifiedHumanAt: newActive.user.verifiedHumanAt,
                sessions: prunedIds,
              },
              { secret: config.secrets.jwt, expiresIn: tokenSettings.jwtExpiry }
            );
            const clientPayload: ClientCookiePayload = {
              userId: newActive.userId,
              updatedAt: newActive.user.updatedAt.toISOString(),
              ...(config.getClientCookiePayload
                ? await config.getClientCookiePayload(newActive.userId)
                : {}),
            };
            setAuthCookies(ctx.res, newJwt, clientPayload, config.secrets.jwt, cookieSettings, storageKeys);
            throw new TRPCError({ code: 'UNAUTHORIZED', message: 'ACTIVE_SESSION_SWITCHED' });
          }

          await revokeSession(ctx, payload.id, !session ? 'Session not found' : 'Session revoked', undefined, path);
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Unauthorized' });
        }

        if (
          session.userId !== payload.userId ||
          (payload.iat && payload.iat < Math.floor(session.issuedAt.getTime() / 1000))
        ) {
          await revokeSession(
            ctx,
            session.id,
            session.userId !== payload.userId
              ? 'Session revoked: Token userId mismatch'
              : 'Session revoked: Token predates session',
            undefined,
            path
          );
          throw new TRPCError({ message: 'Unauthorized', code: 'UNAUTHORIZED' });
        }

        if (session.user.status === 'BANNED') {
          await revokeSession(ctx, session.id, 'Session revoked: User banned', undefined, path);
          throw new TRPCError({ message: 'Unauthorized', code: 'UNAUTHORIZED' });
        }

        if (config.features?.biometric && config.hooks?.getBiometricTimeout) {
          const timeoutMs = await config.hooks.getBiometricTimeout();
          if (
            timeoutMs !== null &&
            !['auth.refresh', 'auth.verifyBiometric', 'auth.logout'].includes(path)
          ) {
            if (!session.user.verifiedHumanAt) {
              throw new TRPCError({
                message: 'Biometric verification not completed. Please verify again.',
                code: 'FORBIDDEN',
              });
            }
            const verificationExpiry = new Date(session.user.verifiedHumanAt.getTime() + timeoutMs);
            if (new Date() > verificationExpiry) {
              throw new TRPCError({
                message: 'Biometric verification expired. Please verify again.',
                code: 'FORBIDDEN',
              });
            }
          }
        }

        if (meta?.adminRequired) {
          const admin = await database.admin.findByUserId(session.userId);
          if (!admin || admin.ip !== ctx.ip) {
            await revokeSession(ctx, session.id, 'Session revoked: Admin not found or IP mismatch', undefined, path);
            throw new TRPCError({ message: 'Unauthorized', code: 'UNAUTHORIZED' });
          }
        }

        const slideNeeded =
          droppedIds.length > 0 ||
          (typeof payload.iat === 'number' &&
            Math.floor(Date.now() / 1000) - payload.iat > SLIDE_THRESHOLD_SECONDS);

        if (slideNeeded) {
          const newJwt = createAuthToken(
            {
              id: session.id,
              userId: session.userId,
              verifiedHumanAt: session.user.verifiedHumanAt,
              sessions: requestedIds,
            },
            { secret: config.secrets.jwt, expiresIn: tokenSettings.jwtExpiry }
          );
          const clientPayload: ClientCookiePayload = {
            userId: session.userId,
            updatedAt: session.user.updatedAt.toISOString(),
            ...(config.getClientCookiePayload
              ? await config.getClientCookiePayload(session.userId)
              : {}),
          };
          setAuthCookies(ctx.res, newJwt, clientPayload, config.secrets.jwt, cookieSettings, storageKeys);
        } else if (storageKeys.clientToken) {
          const rawClientCookie = parseClientCookie(ctx.headers.cookie, storageKeys);
          let needsRefresh = !rawClientCookie;
          if (rawClientCookie && !needsRefresh) {
            const parsed = parseClientCookiePayload(rawClientCookie, config.secrets.jwt);
            if (!parsed || !parsed.updatedAt) {
              needsRefresh = true;
            } else if (parsed.updatedAt !== session.user.updatedAt.toISOString()) {
              needsRefresh = true;
            } else if (parsed.userId !== session.userId) {
              needsRefresh = true;
            }
          }
          if (needsRefresh) {
            const clientPayload: ClientCookiePayload = {
              userId: session.userId,
              updatedAt: session.user.updatedAt.toISOString(),
              ...(config.getClientCookiePayload
                ? await config.getClientCookiePayload(session.userId)
                : {}),
            };
            setClientCookie(ctx.res, clientPayload, config.secrets.jwt, cookieSettings, storageKeys as { clientToken: string });
          }
        }

        return next({
          ctx: {
            ...ctx,
            userId: session.userId,
            socketId: session.socketId,
            sessionId: session.id,
            bundleSessionIds: requestedIds,
          },
        });
      } catch (err: unknown) {
        if (err instanceof TRPCError && err.code === 'FORBIDDEN') throw err;
        if (err instanceof TRPCError && err.code === 'UNAUTHORIZED') throw err;

        if (!meta?.authRequired) {
          return next({ ctx: { ...ctx, userId: 0 } });
        }

        const errorStack = err instanceof Error ? err.stack : undefined;
        if (isTokenExpiredError(err) || isTokenInvalidError(err)) {
          await revokeSession(
            ctx,
            null,
            isTokenInvalidError(err)
              ? 'Session revoked: Token invalid'
              : 'Session revoked: Token expired',
            errorStack,
            path,
          );
          throw new TRPCError({
            message: isTokenInvalidError(err) ? 'Token invalid' : 'Token expired',
            code: 'UNAUTHORIZED',
          });
        }
        throw err;
      }
    }

    // No auth token
    if (!meta?.authRequired) {
      return next({ ctx: { ...ctx, userId: 0 } });
    }
    await revokeSession(ctx, null, 'Session revoked: No token sent', undefined, path);
    throw new TRPCError({ message: 'Unauthorized', code: 'UNAUTHORIZED' });
  });

  return authGuard;
}
