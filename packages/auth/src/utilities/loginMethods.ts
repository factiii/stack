import { TRPCError } from '@trpc/server';

import type { ResolvedAuthConfig } from './config';

// TOTP/2FA is a step-up layer on password login, not a standalone method, so it
// is never counted here.

export type LoginMethodRemoval =
  { kind: 'oauth'; provider: 'GOOGLE' | 'APPLE' } | { kind: 'passkey' } | { kind: 'password' };

export interface LoginMethodCount {
  password: boolean;
  passkeys: number;
  providers: Array<'GOOGLE' | 'APPLE'>;
  total: number;
}

export async function countLoginMethods(
  config: ResolvedAuthConfig,
  userId: number
): Promise<LoginMethodCount> {
  const [user, passkeys, providers] = await Promise.all([
    config.database.user.findById(userId),
    config.passkey ? config.passkey.list(userId).then((p) => p.length) : Promise.resolve(0),
    config.oauthAccounts
      ? config.oauthAccounts.list(userId)
      : Promise.resolve<Array<'GOOGLE' | 'APPLE'>>([]),
  ]);
  const password = Boolean(user?.password);
  return {
    password,
    passkeys,
    providers,
    total: (password ? 1 : 0) + passkeys + providers.length,
  };
}

export interface ResolvedLoginMethods {
  found: boolean;
  hasPassword: boolean;
  hasPasskey: boolean;
  providers: Array<'GOOGLE' | 'APPLE'>;
}

/** Which methods an account (by username) has. Unknown username → `found:false`
 * with everything empty, so a caller can present a non-committal default set
 * rather than confirm existence. Consumers own rate-limiting. */
export async function resolveLoginMethods(
  config: ResolvedAuthConfig,
  username: string
): Promise<ResolvedLoginMethods> {
  const user = await config.database.user.findByUsernameInsensitive(username);
  if (!user) {
    return { found: false, hasPassword: false, hasPasskey: false, providers: [] };
  }
  const c = await countLoginMethods(config, user.id);
  return {
    found: true,
    hasPassword: c.password,
    hasPasskey: c.passkeys > 0,
    providers: c.providers,
  };
}

/** Throws BAD_REQUEST if removing `removal` would leave the account unable to sign in. */
export async function assertKeepsLoginMethod(
  config: ResolvedAuthConfig,
  userId: number,
  removal: LoginMethodRemoval
): Promise<void> {
  const c = await countLoginMethods(config, userId);
  let total = c.total;
  if (removal.kind === 'password' && c.password) total -= 1;
  if (removal.kind === 'passkey' && c.passkeys > 0) total -= 1;
  if (removal.kind === 'oauth' && c.providers.includes(removal.provider)) total -= 1;

  if (total <= 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: "You can't remove your only sign-in method. Add another first.",
    });
  }
}
