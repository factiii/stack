import appleSignin from 'apple-signin-auth';
import { OAuth2Client } from 'google-auth-library';

export type OAuthProvider = 'GOOGLE' | 'APPLE';

export interface OAuthResult {
  /**
   * The email the PROVIDER vouches for, or undefined when it vouches for none.
   *
   * Optional on purpose. An email here is used to attach a new identity to an
   * existing account, so it must only ever come from a verified token — never
   * from the client, and never from a provider claim marked unverified. When
   * there is no such email the verifier still succeeds: `oauthId` alone is what
   * resolves an already-linked account, and a linked user whose token omits the
   * email must keep signing in. Callers that need an email to attach or create
   * must refuse on its absence, as `oAuthLogin` does.
   */
  email?: string;
  oauthId: string;
}

/**
 * OAuth keys configuration for Google and Apple providers
 */
export interface OAuthKeys {
  google?: {
    clientId: string;
    clientSecret?: string;
    iosClientId?: string;
  };
  apple?: {
    clientId: string;
    iosClientId?: string;
  };
}

/**
 * OAuth verification error
 */
export class OAuthVerificationError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 401
  ) {
    super(message);
    this.name = 'OAuthVerificationError';
  }
}

/**
 * Creates an OAuth token verifier with the provided keys
 * @param keys OAuth provider keys configuration
 * @returns A function to verify OAuth tokens
 */
export function createOAuthVerifier(keys: OAuthKeys) {
  let googleClient: OAuth2Client | null = null;
  if (keys.google?.clientId) {
    googleClient = new OAuth2Client({
      clientId: keys.google.clientId,
      clientSecret: keys.google.clientSecret,
    });
  }

  return async function verifyOAuthToken(
    provider: OAuthProvider,
    token: string,
    // Still accepted so every caller's signature keeps compiling, and never read.
    // It is the client-supplied email that used to fill in for a missing Apple
    // token email — see the Apple branch for why that can no longer happen.
    _extra?: { email?: string }
  ): Promise<OAuthResult> {
    if (provider === 'GOOGLE') {
      if (!keys.google?.clientId) {
        throw new OAuthVerificationError('Google OAuth configuration missing', 500);
      }

      if (!googleClient) {
        throw new OAuthVerificationError('Google OAuth client not initialized', 500);
      }

      const audience = [keys.google.clientId];
      if (keys.google.iosClientId) {
        audience.push(keys.google.iosClientId);
      }

      const ticket = await googleClient.verifyIdToken({
        idToken: token,
        audience,
      });

      const payload = ticket.getPayload();
      if (!payload?.sub) {
        throw new OAuthVerificationError('Invalid Google token', 401);
      }

      // A Google ID token can carry an email Google has NOT verified, flagged
      // `email_verified: false`. The email is what attaches a new identity to an
      // existing account, so an unverified one would let whoever holds that
      // Google account claim an address they never proved they own. Trust it
      // only when Google says it checked.
      return {
        oauthId: payload.sub,
        email: payload.email && payload.email_verified === true ? payload.email : undefined,
      };
    }

    if (provider === 'APPLE') {
      if (!keys.apple?.clientId) {
        throw new OAuthVerificationError('Apple OAuth configuration missing', 500);
      }

      const audience = [keys.apple.clientId];
      if (keys.apple.iosClientId) {
        audience.push(keys.apple.iosClientId);
      }

      const { sub, email } = await appleSignin.verifyIdToken(token, {
        audience,
        ignoreExpiration: false,
      });

      if (!sub) {
        throw new OAuthVerificationError('Invalid Apple token', 401);
      }

      // Only the signed token may name the email. This used to fall back to
      // `extra.email` — a value the CLIENT sends — whenever the token carried no
      // email claim. Combined with attach-by-email in `oAuthLogin`, that let
      // anyone holding a valid Apple token for their own Apple ID name a victim's
      // address and be signed into the victim's passwordless account.
      //
      // No email is not an error: an Apple user already linked by `sub` must keep
      // signing in when Apple omits the claim, and `oAuthLogin` resolves them by
      // `sub` before it ever looks at the email.
      return {
        oauthId: sub,
        email: email || undefined,
      };
    }

    throw new OAuthVerificationError('Unsupported OAuth provider', 400);
  };
}
