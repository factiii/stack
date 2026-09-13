/**
 * Email sign-in: one email carries a sign-in link and a 6-digit code for the same
 * attempt.
 *
 * - `request` never reveals whether an account exists: the same body, padded to
 *   the same timing, and a rate-limited request answers the same way.
 * - A link and its code are one attempt, consumed once and atomically, by
 *   whichever arrives first.
 * - An email signs into an existing account only if that account proved the
 *   address. An unproven one may be an account someone else registered in the
 *   victim's name (the same rule as the OAuth attach fix).
 * - Every mint runs the account-status rule (`utilities/accountStatus.ts`) and
 *   the factor-class gate (`twoFa/deviceStep.ts`).
 * - No GET mints a session: `verifyLink` is a mutation the consumer's confirm
 *   page calls after showing the address, because mail scanners pre-fetch links.
 */
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'crypto';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import type { AuthEmailLoginAttempt, AuthUser, DatabaseAdapter } from '../adapters/database';
import { type BaseProcedure, type TrpcContext } from '../types/trpc';
import { assertCanMintSession } from '../utilities/accountStatus';
import { detectBrowser } from '../utilities/browser';
import type { ResolvedAuthConfig, ResolvedEmailLoginConfig } from '../utilities/config';
import { createUserWithFreshUsername, uniqueViolationField } from '../utilities/createUser';
import { sameIdentifier } from '../utilities/emailMatch';
import {
  carryDeviceTwoFaSecret,
  issueAuthCookies,
  revokeDeviceSessionsForUser,
} from '../utilities/issueCookies';
import { requiresDeviceStep, runDeviceStep } from './twoFa/deviceStep';

/** Wrong codes an attempt survives; the fifth one spends it. */
const MAX_CODE_TRIES = 5;
/** Every limit counts over the same window an attempt lives. */
const LIMIT_WINDOW_SEC = 15 * 60;
/** Requests one address may make from one IP. */
const REQUESTS_PER_EMAIL_AND_IP = 3;
/**
 * Requests one address may receive from every IP together. Higher than the
 * per-IP pair limit, so a stranger's requests from one IP cannot use up the
 * owner's; it caps how much mail anyone can aim at one inbox.
 */
const REQUESTS_PER_EMAIL = 10;
const REQUESTS_PER_IP = 10;
const VERIFIES_PER_IP = 20;
const TOKEN_BYTES = 32;
const CODE_SPACE = 1_000_000;
const CODE_DIGITS = 6;

const CODE_DID_NOT_WORK = 'That code did not work. Check it and try again.';
const LINK_EXPIRED = 'That link has expired. Ask for a new one.';
const EMAIL_NOT_CONFIRMED = 'Sign in another way, then confirm this email in your account.';
const TOO_MANY_TRIES = 'Too many tries. Wait a few minutes and try again.';

type AttemptStore = NonNullable<DatabaseAdapter['emailLoginAttempt']>;

/** Trim and lowercase, so one inbox is one rate-limit key and one attempt chain. */
export function normalizeLoginEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** sha256 of the link token — the only form of it that is stored. */
export function hashLoginToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * HMAC of the code, bound to its attempt. A plain hash of a 6-digit code falls
 * to a million guesses offline; the pepper is what a database leak does not have.
 */
export function hashLoginCode(pepper: string, attemptId: string, code: string): string {
  return createHmac('sha256', pepper).update(`${attemptId}:${code}`).digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const platformSchema = z.enum(['ios', 'android', 'web']);

/** What a client sends to answer, or be offered, the second step. */
const deviceStepFields = {
  /** TOTP or backup code, for an account with 2FA on. */
  twoFaCode: z.string().max(64).optional(),
  /** Binds a push approval to this client; handed to `onDeviceStepRequired`. */
  approvalNonce: z.string().max(256).optional(),
  /** Lets the consumer leave this phone out of its own approval targets. */
  devicePushToken: z.string().max(512).optional(),
  platform: platformSchema.optional(),
};

export const emailLoginRequestSchema = z.object({
  email: z.string().trim().email().max(254),
  app: z.string().min(1).max(64),
  platform: platformSchema.optional(),
});

export const emailLoginVerifyLinkSchema = z.object({
  token: z.string().min(1).max(256),
  ...deviceStepFields,
});

export const emailLoginVerifyCodeSchema = z.object({
  email: z.string().trim().email().max(254),
  code: z.string().regex(/^\d{6}$/),
  ...deviceStepFields,
});

export const emailLoginPeekLinkSchema = z.object({
  token: z.string().min(1).max(256),
});

/**
 * `ada@example.com` → `a•••@example.com`: enough for the owner to recognise the
 * address on a confirm screen, and it hides a `+tag`. Only ever shown to whoever
 * holds the link, who already received the email.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '•••';
  return `${email[0]}•••${email.slice(at)}`;
}

type DeviceStepInput = {
  twoFaCode?: string;
  approvalNonce?: string;
  devicePushToken?: string;
  platform?: z.infer<typeof platformSchema>;
};

/** Confirm-screen lookups one IP may make; past it every link reads as not valid. */
const PEEKS_PER_IP = 30;

type PeekLinkResult = { valid: true; maskedEmail: string } | { valid: false };

/** Factory for `auth.emailLogin.*`. */
export class EmailLoginProcedureFactory {
  constructor(
    private config: ResolvedAuthConfig,
    private procedure: BaseProcedure
  ) {}

  createEmailLoginProcedures() {
    return {
      request: this.request(),
      peekLink: this.peekLink(),
      verifyLink: this.verifyLink(),
      verifyCode: this.verifyCode(),
    };
  }

  /**
   * The masked address of an open link, for the confirm screen that names it
   * before anyone signs in. A mutation, so a mail scanner's pre-fetch never calls
   * it. It spends nothing and says nothing about accounts: the address is the
   * attempt's own, which whoever holds the token already received.
   */
  private peekLink() {
    return this.procedure
      .input(emailLoginPeekLinkSchema)
      .mutation(async ({ ctx, input }): Promise<PeekLinkResult> => {
        const { emailLogin, attempts } = this.settings();
        const allowed = await emailLogin.rateLimit(
          `emailLogin:peek:ip:${ctx.ip ?? 'unknown'}`,
          PEEKS_PER_IP,
          LIMIT_WINDOW_SEC
        );
        if (!allowed) return { valid: false };

        const attempt = await attempts.findByTokenHash(hashLoginToken(input.token));
        if (!attempt || attempt.consumedAt || attempt.expiresAt <= new Date()) {
          return { valid: false };
        }
        return { valid: true, maskedEmail: maskEmail(attempt.email) };
      });
  }

  /** The resolved settings and attempt store, or NOT_FOUND while the feature is off. */
  private settings(): { emailLogin: ResolvedEmailLoginConfig; attempts: AttemptStore } {
    if (!this.config.features.emailLogin) {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }
    const { emailLogin } = this.config;
    const attempts = this.config.database.emailLoginAttempt;
    // createAuthConfig refuses to start without either; this is the net for a
    // hand-built ResolvedAuthConfig.
    if (!emailLogin || !attempts) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Email login is not configured',
      });
    }
    return { emailLogin, attempts };
  }

  /** The account a verified address belongs to — exactly that address, never a look-alike. */
  private async accountFor(email: string): Promise<AuthUser | null> {
    const found = await this.config.database.user.findByEmailInsensitive(email);
    // A lookup is only as exact as its adapter. The address the inbox proved is
    // the one that has to be on the account.
    return found && sameIdentifier(found.email, email) ? found : null;
  }

  private request() {
    return this.procedure.input(emailLoginRequestSchema).mutation(async ({ ctx, input }) => {
      const { emailLogin, attempts } = this.settings();

      // A config error, not an oracle: it answers the same for every address.
      // Own keys only, so `constructor` or `__proto__` is not an app.
      const app = Object.prototype.hasOwnProperty.call(emailLogin.apps, input.app)
        ? emailLogin.apps[input.app]
        : undefined;
      if (!app) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown app.' });
      }

      const startedAt = Date.now();
      try {
        const email = normalizeLoginEmail(input.email);
        const ip = ctx.ip ?? 'unknown';
        // Each limit is asked only when the one before it passed, so a refused
        // request does not also spend the wider budgets.
        const allowed =
          (await emailLogin.rateLimit(
            `emailLogin:request:emailip:${email}:${ip}`,
            REQUESTS_PER_EMAIL_AND_IP,
            LIMIT_WINDOW_SEC
          )) &&
          (await emailLogin.rateLimit(
            `emailLogin:request:ip:${ip}`,
            REQUESTS_PER_IP,
            LIMIT_WINDOW_SEC
          )) &&
          (await emailLogin.rateLimit(
            `emailLogin:request:email:${email}`,
            REQUESTS_PER_EMAIL,
            LIMIT_WINDOW_SEC
          ));

        // Rate-limited: send nothing, and say nothing different about it.
        if (allowed) {
          const user = await this.accountFor(email);

          // A newer request replaces every open one, so an email the user did
          // not act on stops working the moment they ask again.
          await attempts.consumeOpenByEmail(email);

          const id = randomUUID();
          const token = randomBytes(TOKEN_BYTES).toString('base64url');
          const code = String(randomInt(0, CODE_SPACE)).padStart(CODE_DIGITS, '0');
          const expiresAt = new Date(Date.now() + emailLogin.ttlMs);

          await attempts.create({
            id,
            email,
            userId: user?.id ?? null,
            app: input.app,
            tokenHash: hashLoginToken(token),
            codeHash: hashLoginCode(emailLogin.pepper, id, code),
            expiresAt,
          });

          // Not awaited. The mail provider's latency would make an allowed request
          // slower than a rate-limited one, and its errors differ by address (a
          // suppressed or bouncing inbox fails where a good one does not) — neither
          // may reach the response.
          void emailLogin
            .sendLoginEmail({
              to: email,
              app: input.app,
              brand: app.brand,
              link: `${app.siteUrl}${app.verifyPath}?token=${encodeURIComponent(token)}`,
              code,
              expiresAt,
            })
            .catch((err: unknown) => this.logSendFailure(err, ctx));
        }
      } finally {
        // Pad every outcome to one floor, so an address with an account does not
        // answer faster or slower than one without.
        const elapsed = Date.now() - startedAt;
        if (elapsed < emailLogin.responseFloorMs) {
          await sleep(emailLogin.responseFloorMs - elapsed);
        }
      }

      return { sent: true as const };
    });
  }

  private logSendFailure(err: unknown, ctx: TrpcContext) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (this.config.hooks?.logError) {
      void this.config.hooks
        .logError({
          type: 'OTHER',
          description: `emailLogin: the sign-in email could not be sent: ${error.message}`,
          stack: error.stack ?? '',
          ip: ctx.ip,
        })
        .catch(() => undefined);
      return;
    }
    console.error('@factiii/auth: the sign-in email could not be sent', error);
  }

  private verifyLink() {
    return this.procedure.input(emailLoginVerifyLinkSchema).mutation(async ({ ctx, input }) => {
      const { emailLogin, attempts } = this.settings();
      await this.limitVerify(emailLogin, ctx);

      const attempt = await attempts.findByTokenHash(hashLoginToken(input.token));
      if (!attempt || attempt.consumedAt || attempt.expiresAt <= new Date()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: LINK_EXPIRED });
      }

      return this.complete(ctx, attempt, input, LINK_EXPIRED);
    });
  }

  private verifyCode() {
    return this.procedure.input(emailLoginVerifyCodeSchema).mutation(async ({ ctx, input }) => {
      const { emailLogin, attempts } = this.settings();
      await this.limitVerify(emailLogin, ctx);

      // Only the newest open attempt can match: a newer request spent the rest.
      const attempt = await attempts.findLatestOpenByEmail(normalizeLoginEmail(input.email));
      if (!attempt) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: CODE_DID_NOT_WORK });
      }

      // Counted before the comparison, so parallel guesses cannot all slip in
      // under the limit while each one reads the old count.
      const tries = await attempts.incrementAttempts(attempt.id);
      if (tries > MAX_CODE_TRIES) {
        await attempts.consume(attempt.id);
        throw new TRPCError({ code: 'BAD_REQUEST', message: CODE_DID_NOT_WORK });
      }

      const expected = hashLoginCode(emailLogin.pepper, attempt.id, input.code);
      if (!sameHash(expected, attempt.codeHash)) {
        if (tries >= MAX_CODE_TRIES) {
          await attempts.consume(attempt.id);
        }
        throw new TRPCError({ code: 'BAD_REQUEST', message: CODE_DID_NOT_WORK });
      }

      return this.complete(ctx, attempt, input, CODE_DID_NOT_WORK);
    });
  }

  private async limitVerify(emailLogin: ResolvedEmailLoginConfig, ctx: TrpcContext) {
    const allowed = await emailLogin.rateLimit(
      `emailLogin:verify:ip:${ctx.ip ?? 'unknown'}`,
      VERIFIES_PER_IP,
      LIMIT_WINDOW_SEC
    );
    if (!allowed) {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: TOO_MANY_TRIES });
    }
  }

  /**
   * Resolve the account, run the status rule and the gate, spend the attempt, and
   * mint. `spentMessage` is what a caller sees when another request spent the
   * attempt first — the same words the link or the code already uses for "no
   * longer valid".
   */
  private async complete(
    ctx: TrpcContext,
    attempt: AuthEmailLoginAttempt,
    input: DeviceStepInput,
    spentMessage: string
  ) {
    const { attempts } = this.settings();
    const browserName = detectBrowser(ctx.headers['user-agent'] ?? '');
    const existing = await this.accountFor(attempt.email);

    if (existing) {
      if (existing.emailVerificationStatus !== 'VERIFIED') {
        await attempts.consume(attempt.id);
        throw new TRPCError({ code: 'BAD_REQUEST', message: EMAIL_NOT_CONFIRMED });
      }

      // Before the second step and before any push: a refused account is told
      // so without ringing a device, and the attempt goes with it.
      try {
        await assertCanMintSession(this.config, existing, {
          firstFactor: 'EMAIL_LOGIN',
          ip: ctx.ip,
        });
      } catch (err) {
        await attempts.consume(attempt.id);
        throw err;
      }

      const account = existing;
      const step = await runDeviceStep(this.config, {
        user: account,
        firstFactor: 'EMAIL_LOGIN',
        code: input.twoFaCode,
        askApproval: async () =>
          this.config.hooks?.onDeviceStepRequired
            ? this.config.hooks.onDeviceStepRequired(account.id, {
                ip: ctx.ip,
                browserName,
                firstFactor: 'EMAIL_LOGIN',
                input: {
                  app: attempt.app,
                  platform: input.platform,
                  approvalNonce: input.approvalNonce,
                  devicePushToken: input.devicePushToken,
                },
              })
            : null,
        // Wrong second-step codes spend the attempt, and two requests racing on
        // it push the device once.
        guard: {
          credentialKey: `emailLogin:${attempt.id}`,
          spend: () => attempts.consume(attempt.id),
          lockApproval: true,
        },
      });

      if (step?.kind === 'pending') {
        // Approval finishes in the consumer's pending-login flow and never comes
        // back here, so the attempt is spent now.
        if (!(await attempts.consume(attempt.id))) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: spentMessage });
        }
        return {
          success: false,
          pendingLogin: true,
          pendingLoginId: step.pendingLoginId,
          userId: account.id,
          requires2FA: true,
        };
      }
      if (step?.kind === 'code') {
        // Left unspent, so the same link or code can come back with `twoFaCode`.
        return {
          success: false,
          requires2FA: true,
          userId: account.id,
        };
      }
    }

    // The single point where the attempt is spent for a sign-in. Of two requests
    // racing on one attempt, only one gets past here.
    if (!(await attempts.consume(attempt.id))) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: spentMessage });
    }

    const { user, created } = existing
      ? { user: existing, created: false }
      : await this.createAccount(ctx, attempt, input, spentMessage);

    // Every account reaching here proved this address just now. The branches
    // above already require VERIFIED; kept explicit so a future branch cannot
    // sign into an unproven address without also proving it.
    if (user.emailVerificationStatus !== 'VERIFIED') {
      await this.config.database.user.update(user.id, { emailVerificationStatus: 'VERIFIED' });
    }

    // The inbox has been proven, so a session this device already holds for the
    // same account is stale, not a reason to refuse.
    const replacedSessionIds = await revokeDeviceSessionsForUser(
      this.config,
      ctx.headers.cookie,
      user.id
    );

    const extraSessionData = this.config.hooks?.getEmailLoginSessionData
      ? await this.config.hooks.getEmailLoginSessionData(user.id, {
          app: attempt.app,
          platform: input.platform,
        })
      : {};

    const session = await this.config.database.session.create({
      userId: user.id,
      browserName,
      socketId: null,
      ...extraSessionData,
    });

    // Same rule as the other sign-in paths: the device keeps the second factor it
    // already had.
    await carryDeviceTwoFaSecret(this.config, {
      userId: user.id,
      revokedSessionIds: replacedSessionIds,
      newSessionId: session.id,
    });

    if (this.config.hooks?.onUserLogin) {
      await this.config.hooks.onUserLogin(user.id, session.id);
    }

    await issueAuthCookies(this.config, {
      ctx,
      session,
      updatedAt: user.updatedAt,
      verifiedHumanAt: user.verifiedHumanAt ?? null,
    });

    return {
      success: true,
      created,
      user: { id: user.id, email: user.email, username: user.username },
    };
  }

  /** First verify for an address with no account: create it, already proven. */
  private async createAccount(
    ctx: TrpcContext,
    attempt: AuthEmailLoginAttempt,
    input: DeviceStepInput,
    spentMessage: string
  ): Promise<{ user: AuthUser; created: boolean }> {
    let user: AuthUser;
    try {
      // A taken generated username is retried inside; what comes out of here is
      // an email violation, another failure, or no free username at all.
      user = await createUserWithFreshUsername(
        this.config,
        {
          email: attempt.email,
          password: null,
          status: 'ACTIVE',
          tag: this.config.features.biometric ? 'BOT' : 'HUMAN',
          emailVerificationStatus: 'VERIFIED',
          verifiedHumanAt: null,
        },
        { ip: ctx.ip }
      );
    } catch (err) {
      // Only a lost race is recovered here; any other failure is a real one. An
      // unnamed violation only comes out of the helper when an account already
      // holds this address, so it is the email index too.
      const field = uniqueViolationField(err);
      if (field !== 'email' && field !== 'unknown') throw err;
      // Two attempts for one inbox can finish together, and the unique email
      // index lets only one insert land. Both proved the address, so the loser
      // signs into the account the winner made — but only a proven account that
      // owes no second step, because this attempt is already spent and cannot
      // pause for one.
      const winner = await this.accountFor(attempt.email);
      if (
        winner &&
        winner.emailVerificationStatus === 'VERIFIED' &&
        !requiresDeviceStep(this.config, winner, 'EMAIL_LOGIN')
      ) {
        await assertCanMintSession(this.config, winner, { firstFactor: 'EMAIL_LOGIN', ip: ctx.ip });
        return { user: winner, created: false };
      }
      if (winner) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: spentMessage });
      }
      throw err;
    }

    // Outside the recovery above: a provisioning failure is not a lost race, and
    // an account nobody provisioned must not get a session.
    if (this.config.hooks?.onEmailLoginUserCreated) {
      await this.config.hooks.onEmailLoginUserCreated(user.id, {
        email: attempt.email,
        app: attempt.app,
        platform: input.platform,
      });
    }
    await assertCanMintSession(this.config, user, { firstFactor: 'EMAIL_LOGIN', ip: ctx.ip });
    return { user, created: true };
  }
}
