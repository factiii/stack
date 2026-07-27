/**
 * WebAuthn / passkey types. The package runs the ceremony; storage and user
 * creation go through AuthHooks. Enable with `features.passkey` + `webauthn`.
 */

export type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

export type PasskeyChallengeType = 'REGISTER' | 'AUTH';

/** A verified WebAuthn credential, handed to the consumer to persist. */
export interface PasskeyCredential {
  /** base64url credential ID */
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  /** "singleDevice" | "multiDevice" */
  deviceType: string | null;
  backedUp: boolean;
}

/** A stored credential, resolved by the consumer for an authentication ceremony. */
export interface StoredPasskeyCredential {
  userId: number;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
}

/** WebAuthn Relying Party configuration. */
export interface WebAuthnConfig {
  /** Registrable domain, e.g. "example.com". Never a full URL. */
  rpID: string;
  /** Human-readable RP name shown by the authenticator. */
  rpName: string;
  /**
   * Every allowed ceremony origin: the web origin (https://example.com), iOS
   * native (https://<rpID>), and Android (android:apk-key-hash:<hash>).
   */
  origins: string[];
}
