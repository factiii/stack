/**
 * The factor-class gate every sign-in path runs before it mints a session.
 *
 * 2FA means two DIFFERENT factor classes, not two items. INBOX is a verified
 * email, an email link or code, a password (email can reset it), and Google or
 * Apple with the same email. DEVICE is a user-verified passkey, TOTP, or push
 * approval from a signed-in device. FEDERATED is Google or Apple with a
 * different email. An account with 2FA on must present a DEVICE factor, so
 * every first factor that is not already one owes the second step.
 *
 * Before this existed only password login asked for it: a magic link or an
 * OAuth sign-in into a 2FA account went straight through. One function, called
 * from every mint site, is how that stays closed.
 */
import { TRPCError } from '@trpc/server';

import type { AuthUser } from '../../adapters/database';
import type { ResolvedAuthConfig } from '../../utilities/config';
import { isTwoFaEnabled, verifyTwoFaChallenge } from './verifyChallenge';

/** How a sign-in proved itself before any second step. */
export type FirstFactor = 'PASSWORD' | 'EMAIL_LOGIN' | 'MAGIC_LINK' | 'OAUTH' | 'PASSKEY';

/**
 * First factors that are already in the DEVICE class. A passkey qualifies only
 * because the passkey procedures require user verification at registration and
 * at authentication — possession plus inherence.
 */
const DEVICE_CLASS: ReadonlySet<FirstFactor> = new Set<FirstFactor>(['PASSKEY']);

/** Wrong second-step codes one first-factor credential absorbs; the last one spends it. */
export const MAX_SECOND_STEP_FAILURES = 5;
/** Second-step codes one account may be sent per window, across every IP and credential. */
export const SECOND_STEP_CODES_PER_USER = 10;
const SECOND_STEP_WINDOW_SEC = 15 * 60;

const TOO_MANY_CODES = 'Too many tries. Wait a few minutes and try again.';

/** True when this account must still present a DEVICE factor after `firstFactor`. */
export function requiresDeviceStep(
  config: ResolvedAuthConfig,
  user: AuthUser,
  firstFactor: FirstFactor
): boolean {
  if (DEVICE_CLASS.has(firstFactor)) return false;
  return Boolean(config.features.twoFa) && isTwoFaEnabled(config, user);
}

/**
 * What the caller returns instead of a session. Call sites build their own
 * response literal from it, so each procedure's inferred output keeps exactly the
 * shape password login has always returned.
 */
export type DeviceStepOutcome = { kind: 'pending'; pendingLoginId: string } | { kind: 'code' };

/**
 * Bounds on guessing the second step. A wrong code leaves the first factor usable
 * on purpose, so without these an attacker who holds the first factor — the inbox,
 * a magic link, a provider token — could rotate IPs and walk TOTP space against
 * one credential.
 *
 * Counts go through `emailLogin.rateLimit`, the consumer's limiter. A path with no
 * limiter configured keeps its old unbounded behaviour, except email sign-in,
 * which requires one.
 */
export interface DeviceStepGuard {
  /** Names the first-factor credential, e.g. `emailLogin:<attemptId>`. */
  credentialKey: string;
  /** Retire the credential once it has absorbed MAX_SECOND_STEP_FAILURES wrong codes. */
  spend?: () => Promise<unknown>;
  /**
   * Ask for push approval at most once per credential, so two requests racing on
   * one link or attempt cannot each push a device. The later one gets the typed-
   * code step instead.
   */
  lockApproval?: boolean;
}

/**
 * Run the gate. `null` means the sign-in may mint now: either no second step is
 * owed, or `code` answered it. A wrong `code` throws. With no code, the account
 * is offered push approval through `askApproval` and falls back to the
 * typed-code step when that returns nothing.
 */
export async function runDeviceStep(
  config: ResolvedAuthConfig,
  params: {
    user: AuthUser;
    firstFactor: FirstFactor;
    code: string | undefined;
    askApproval: () => Promise<{ pendingLoginId: string } | null>;
    guard?: DeviceStepGuard;
  }
): Promise<DeviceStepOutcome | null> {
  const { user, firstFactor, code, askApproval, guard } = params;
  if (!requiresDeviceStep(config, user, firstFactor)) return null;

  const limit = guard ? config.emailLogin?.rateLimit : undefined;
  if (guard && !limit && firstFactor === 'EMAIL_LOGIN') {
    // createAuthConfig requires the limiter for email sign-in; this is the net for
    // a hand-built config, and an unbounded second step is not a degraded mode.
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Email login is not configured',
    });
  }

  if (code) {
    if (
      limit &&
      !(await limit(
        `twoFa:code:user:${user.id}`,
        SECOND_STEP_CODES_PER_USER,
        SECOND_STEP_WINDOW_SEC
      ))
    ) {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: TOO_MANY_CODES });
    }

    const valid = await verifyTwoFaChallenge(config, user, code);
    if (!valid) {
      // The limiter allows `max` calls, so a max one short of the failure budget
      // refuses exactly on the last wrong code — which is when the credential goes.
      if (
        limit &&
        guard &&
        !(await limit(
          `twoFa:fail:${guard.credentialKey}`,
          MAX_SECOND_STEP_FAILURES - 1,
          SECOND_STEP_WINDOW_SEC
        ))
      ) {
        await guard.spend?.();
      }
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Invalid 2FA code.',
      });
    }
    return null;
  }

  if (
    limit &&
    guard?.lockApproval &&
    !(await limit(`twoFa:approval:${guard.credentialKey}`, 1, SECOND_STEP_WINDOW_SEC))
  ) {
    return { kind: 'code' };
  }

  const pending = await askApproval();
  if (pending) return { kind: 'pending', pendingLoginId: pending.pendingLoginId };
  return { kind: 'code' };
}
