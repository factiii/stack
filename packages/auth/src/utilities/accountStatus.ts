/**
 * The account-status rule every mint site applies before its 2FA gate and before
 * any side effect (a push, a provider link, a session).
 *
 * Password login always refused a deactivated or banned account, but a magic link,
 * a passkey, and parts of OAuth never checked — and a consumer's own status rules
 * lived in `beforeLogin`, which only password login calls. One function here, and
 * one hook, close every path the same way.
 *
 * DELETED is deliberately left to `hooks.beforeSessionMint`: a consumer may let a
 * deleted account back in during a grace window so it can cancel the deletion, and
 * only the consumer knows that window.
 */
import { TRPCError } from '@trpc/server';

import type { AuthUser } from '../adapters/database';
import type { FirstFactor } from '../procedures/twoFa/deviceStep';
import type { ResolvedAuthConfig } from './config';

export async function assertCanMintSession(
  config: ResolvedAuthConfig,
  user: AuthUser,
  context: { firstFactor: FirstFactor; ip?: string }
): Promise<void> {
  if (user.status === 'DEACTIVATED') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Your account has been deactivated.' });
  }
  if (user.status === 'BANNED') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Your account has been banned.' });
  }
  if (config.hooks?.beforeSessionMint) {
    await config.hooks.beforeSessionMint(user.id, context);
  }
}
