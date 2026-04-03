import type { ResolvedAuthConfig } from './config';

export interface CreateMagicLinkParams {
  userId: number;
  expiresInMs?: number;
  redirect?: string;
}

export interface CreateMagicLinkResult {
  url: string;
  token: string;
  expiresAt: Date;
}

/**
 * Create a magic link token and return the full verification URL.
 *
 * Use this server-side inside app-specific logic (e.g., invite flows).
 * The returned URL points to the host app's verification page which
 * calls the `auth.verifyMagicLink` tRPC procedure.
 */
export async function createMagicLink(
  config: ResolvedAuthConfig,
  params: CreateMagicLinkParams,
): Promise<CreateMagicLinkResult> {
  if (!config.magicLink) {
    throw new Error('@factiii/auth: magicLink config is required to create magic links');
  }

  if (!config.database.magicLink) {
    throw new Error(
      '@factiii/auth: database adapter does not support magicLink — add the MagicLink model to your schema',
    );
  }

  const expiresAt = new Date(Date.now() + (params.expiresInMs ?? config.magicLink.defaultExpiryMs));

  const magicLink = await config.database.magicLink.create({
    userId: params.userId,
    expiresAt,
  });

  const urlParams = new URLSearchParams({ token: magicLink.id });
  if (params.redirect) {
    urlParams.set('redirect', params.redirect);
  }

  const url = `${config.magicLink.siteUrl}${config.magicLink.verifyPath}?${urlParams.toString()}`;

  return { url, token: magicLink.id, expiresAt };
}
