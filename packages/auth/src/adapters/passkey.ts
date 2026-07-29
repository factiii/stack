/**
 * Passkey (WebAuthn) storage adapter for @factiii/auth.
 *
 * Required (and only used) when `features.passkey` is enabled. The package runs
 * the WebAuthn ceremony and mints the session; this adapter owns all storage —
 * the short-lived challenge, the credential, and user creation. See
 * `prisma/schema.*.prisma` for the reference `Passkey` model.
 */
import type { PasskeyChallengeType, PasskeyCredential, StoredPasskeyCredential } from '../types/passkey';
import type { PasskeyRegisterInput, SchemaExtensions } from '../types/hooks';

export interface PasskeyAdapter<TExtensions extends SchemaExtensions = {}> {
  /** Persist a short-lived challenge; return a `flowId` the client echoes back on verify. */
  storeChallenge(data: {
    challenge: string;
    type: PasskeyChallengeType;
    username: string | null;
    expiresAt: Date;
  }): Promise<{ flowId: string }>;

  /** Look up + delete a challenge by flowId. Null if missing/expired. */
  consumeChallenge(
    flowId: string
  ): Promise<{ challenge: string; type: PasskeyChallengeType; username: string | null } | null>;

  /** Create the user and persist the verified credential; return the new userId. */
  createUser(input: PasskeyRegisterInput<TExtensions>): Promise<{ userId: number }>;

  /** Resolve a stored credential for an authentication ceremony. Null if unknown. */
  resolveCredential(credentialId: string): Promise<StoredPasskeyCredential | null>;

  /** Persist the updated signature counter after a successful authentication. */
  onAuthenticated(credentialId: string, newCounter: number): Promise<void>;

  /** Whether a user has any passkey — used to label the login method accurately. */
  has(userId: number): Promise<boolean>;

  /** List a user's credentials (settings list, `excludeCredentials`, keep-one guard). */
  list(userId: number): Promise<
    Array<{
      id: string;
      credentialId: string;
      transports: string[];
      name: string | null;
      createdAt: Date;
      lastUsedAt: Date | null;
    }>
  >;

  /** Persist a verified credential against an existing user. */
  add(
    userId: number,
    credential: PasskeyCredential & { name?: string | null }
  ): Promise<{ id: string }>;

  /** Delete one of the user's passkeys by its storage id. */
  remove(userId: number, id: string): Promise<void>;
}
