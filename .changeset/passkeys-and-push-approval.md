---
'@factiii/auth': minor
---

Add WebAuthn passkeys and push-approval login.

Passkeys: new `auth.passkey.*` sub-router (registerOptions / registerVerify /
authOptions / authVerify) behind `features.passkey` + a `webauthn` config block.
The package runs the ceremony and mints the session; storage and user creation
are delegated to the new `storePasskeyChallenge`, `consumePasskeyChallenge`,
`createPasskeyUser`, `resolvePasskeyCredential`, `onPasskeyAuthenticated` and
`userHasPasskey` hooks. Credentials are registered with `residentKey: 'required'`
and `userVerification: 'required'`, since a passkey is the account's only factor
and sign-in uses an empty `allowCredentials` list.

Push-approval login: the new `onLoginApprovalRequired` hook lets a consumer turn
a 2FA-required password login into a push the user approves on another device.
`auth.login` then returns `{ pendingLogin: true, pendingLoginId, userId }`
instead of `{ requires2FA: true }`. The `userId` lets a client that already holds
the user's TOTP secret locally answer the challenge itself rather than waiting on
a second device.

**Breaking (types):** `AuthUser.email` is now `string | null`. Username-first
consumers can have accounts with no address, and the old non-nullable type made
that a silent lie: `sendPasswordResetEmail` and the 2FA-reset OTP both passed it
straight to the email service. Both now fail with a clear message instead, and
the `user.email` returned by register/login/oauth/passkey can be null.

**Behaviour change:** `enableTwofa` (both the device and standard flows) now
rejects any account without a password, where it previously only rejected OAuth
accounts. 2FA gates the password login, so on a passwordless account it guarded a
code path the user could never reach, and `disableTwofa` (password-gated) could
never turn it back off. This also covers passkey accounts, which are already
two-factor via the required user-verification gesture.

Also: passwordless-account login errors now name the exact method (passkey vs a
specific OAuth provider) instead of saying "social login", and
`sendVerificationEmail` no longer flips a user to PENDING when they have no email
on file.
