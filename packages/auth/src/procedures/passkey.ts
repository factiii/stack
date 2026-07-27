import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { TRPCError } from '@trpc/server';
import { z, type AnyZodObject } from 'zod';

import type { PasskeyRegisterInput, SchemaExtensions } from '../types/hooks';
import { type BaseProcedure } from '../types/trpc';
import { detectBrowser } from '../utilities';
import type { ResolvedAuthConfig } from '../utilities/config';
import { issueAuthCookies, isUserInBundle } from '../utilities/issueCookies';
import { type CreatedSchemas } from '../validators';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const isObject = (v: unknown): boolean => typeof v === 'object' && v !== null;

/**
 * Factory for WebAuthn passkey procedures (registerOptions / registerVerify /
 * authOptions / authVerify). The package runs the ceremony and mints the session
 * (via `issueAuthCookies`, so passkey logins are bundle-aware just like password
 * and OAuth); the consumer owns all storage + user creation through hooks.
 */
export class PasskeyProcedureFactory<TExtensions extends SchemaExtensions = {}> {
  constructor(
    private config: ResolvedAuthConfig,
    private procedure: BaseProcedure
  ) {}

  private checkConfig() {
    if (!this.config.features.passkey) {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }
    if (!this.config.webauthn) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Passkeys enabled but no `webauthn` config was provided.',
      });
    }
    const h = this.config.hooks;
    if (
      !h?.storePasskeyChallenge ||
      !h?.consumePasskeyChallenge ||
      !h?.createPasskeyUser ||
      !h?.resolvePasskeyCredential
    ) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message:
          'Passkeys enabled but required passkey hooks are missing (storePasskeyChallenge, consumePasskeyChallenge, createPasskeyUser, resolvePasskeyCredential).',
      });
    }
    return { webauthn: this.config.webauthn, hooks: h };
  }

  createPasskeyProcedures(schemas: CreatedSchemas<TExtensions>) {
    // Signup metadata minus email/password, and minus username: the account is
    // created under the name bound to the challenge, so it always matches what
    // the authenticator saved.
    const registerMeta = (schemas.signup as AnyZodObject).omit({
      email: true,
      password: true,
      username: true,
    });
    const loginMeta = (schemas.login as AnyZodObject).omit({
      username: true,
      password: true,
      code: true,
    });

    return {
      registerOptions: this.registerOptions(),
      registerVerify: this.registerVerify(registerMeta),
      authOptions: this.authOptions(),
      authVerify: this.authVerify(loginMeta),
    };
  }

  private registerOptions() {
    return this.procedure
      .input(z.object({ username: z.string() }))
      .mutation(async ({ input }) => {
        const { webauthn, hooks } = this.checkConfig();

        const options = await generateRegistrationOptions({
          rpName: webauthn.rpName,
          rpID: webauthn.rpID,
          userName: input.username,
          attestationType: 'none',
          excludeCredentials: [],
          authenticatorSelection: {
            // Neither is negotiable: sign-in passes an empty allowCredentials so
            // a non-discoverable credential could never be offered back, and the
            // UV gesture is what makes a sole-factor passkey two-factor.
            residentKey: 'required',
            userVerification: 'required',
          },
        });

        const { flowId } = await hooks.storePasskeyChallenge!({
          challenge: options.challenge,
          type: 'REGISTER',
          username: input.username,
          expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
        });

        return { flowId, options };
      });
  }

  private registerVerify(registerMeta: AnyZodObject) {
    const schema = registerMeta.extend({
      flowId: z.string(),
      response: z.custom<RegistrationResponseJSON>(isObject),
    });

    return this.procedure.input(schema).mutation(async ({ ctx, input }) => {
      const { webauthn, hooks } = this.checkConfig();
      const typedInput = input as {
        flowId: string;
        response: RegistrationResponseJSON;
      } & Record<string, unknown>;

      const challenge = await hooks.consumePasskeyChallenge!(typedInput.flowId);
      if (!challenge || challenge.type !== 'REGISTER' || !challenge.username) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Passkey challenge expired. Please try again.',
        });
      }

      const verification = await verifyRegistrationResponse({
        response: typedInput.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: webauthn.origins,
        expectedRPID: webauthn.rpID,
        requireUserVerification: true,
      });
      if (!verification.verified || !verification.registrationInfo) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Passkey verification failed.' });
      }

      const { credential, credentialDeviceType, credentialBackedUp } =
        verification.registrationInfo;

      const { flowId: _flowId, response: _response, ...metadata } = typedInput;
      void _flowId;
      void _response;

      const { userId } = await hooks.createPasskeyUser!({
        ...metadata,
        // From the challenge, never from this request's body: see registerMeta.
        username: challenge.username,
        credential: {
          credentialId: credential.id,
          publicKey: credential.publicKey,
          counter: credential.counter,
          transports: credential.transports ?? [],
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
        },
      } as PasskeyRegisterInput<TExtensions>);

      return this.mintSession(ctx, userId, typedInput);
    });
  }

  private authOptions() {
    // No input: sign-in is fully discoverable, so there is nothing to send.
    return this.procedure.mutation(async () => {
      const { webauthn, hooks } = this.checkConfig();

      // Discoverable credentials, so no allowCredentials: avoids username
      // enumeration and enables conditional-UI autofill.
      const options = await generateAuthenticationOptions({
        rpID: webauthn.rpID,
        userVerification: 'required',
        allowCredentials: [],
      });

      const { flowId } = await hooks.storePasskeyChallenge!({
        challenge: options.challenge,
        type: 'AUTH',
        username: null,
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      });

      return { flowId, options };
    });
  }

  private authVerify(loginMeta: AnyZodObject) {
    // Auth carries the login extension fields (e.g. instanceId) but not
    // username/password/code.
    const schema = loginMeta.extend({
      flowId: z.string(),
      response: z.custom<AuthenticationResponseJSON>(isObject),
    });

    return this.procedure.input(schema).mutation(async ({ ctx, input }) => {
      const { webauthn, hooks } = this.checkConfig();
      const typedInput = input as {
        flowId: string;
        response: AuthenticationResponseJSON;
      } & Record<string, unknown>;

      const challenge = await hooks.consumePasskeyChallenge!(typedInput.flowId);
      if (!challenge || challenge.type !== 'AUTH') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Passkey challenge expired. Please try again.',
        });
      }

      const stored = await hooks.resolvePasskeyCredential!(typedInput.response.id);
      if (!stored) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Passkey not recognized.' });
      }

      const verification = await verifyAuthenticationResponse({
        response: typedInput.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: webauthn.origins,
        expectedRPID: webauthn.rpID,
        requireUserVerification: true,
        credential: {
          id: typedInput.response.id,
          publicKey: new Uint8Array(stored.publicKey),
          counter: stored.counter,
          transports: stored.transports as AuthenticatorTransportFuture[],
        },
      });
      if (!verification.verified) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Passkey verification failed.' });
      }

      if (hooks.onPasskeyAuthenticated) {
        await hooks.onPasskeyAuthenticated(
          typedInput.response.id,
          verification.authenticationInfo.newCounter
        );
      }

      return this.mintSession(ctx, stored.userId, typedInput);
    });
  }

  /** Shared session issuance for passkey register + auth (bundle-aware cookie). */
  private async mintSession(
    ctx: Parameters<Parameters<BaseProcedure['mutation']>[0]>[0]['ctx'],
    userId: number,
    input: Record<string, unknown>
  ) {
    const userAgent = ctx.headers['user-agent'];
    if (!userAgent) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'User agent not found' });
    }

    const user = await this.config.database.user.findById(userId);
    if (!user) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'User not found after passkey ceremony.' });
    }

    if (await isUserInBundle(this.config, ctx.headers.cookie, user.id)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'You are already signed in as this account on this device.',
      });
    }

    const extraSessionData = this.config.hooks?.getSessionData
      ? await this.config.hooks.getSessionData(input as never)
      : {};

    const session = await this.config.database.session.create({
      userId: user.id,
      browserName: detectBrowser(userAgent),
      socketId: null,
      ...extraSessionData,
    });

    if (this.config.hooks?.onUserLogin) {
      await this.config.hooks.onUserLogin(user.id, session.id);
    }
    if (this.config.hooks?.onSessionCreated) {
      await this.config.hooks.onSessionCreated(session.id, input as never);
    }

    await issueAuthCookies(this.config, {
      ctx,
      session,
      updatedAt: user.updatedAt,
      verifiedHumanAt: user.verifiedHumanAt ?? null,
    });

    return {
      success: true,
      user: { id: user.id, email: user.email, username: user.username },
    };
  }
}
