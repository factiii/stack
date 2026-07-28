---
'@factiii/auth': minor
---

Multi-method accounts: one account can hold a password, several passkeys, and
both Google and Apple at once, and manage them from settings.

Passkey and multi-provider storage now live in dedicated **adapters**
(`config.passkey`, `config.oauthAccounts`) mirroring `deviceAuth`, instead of
loose entries in `hooks`.

**Breaking — OAuth is now table-based.** The `User.oauthProvider` / `oauthId`
scalar is gone; the `OAuthAccount` table (via `config.oauthAccounts`) is the sole
source of truth. Concretely:
- `AuthUser` and `CreateUserData` no longer include `oauthProvider` / `oauthId`,
  and `findByEmailOrOAuthId` is removed from `DatabaseAdapter`. Drop the
  `oauthProvider` / `oauthId` columns from your User table. The prebuilt Prisma
  and Drizzle adapters already reflect this.
- `oAuthLogin` requires a `config.oauthAccounts` adapter (throws if OAuth is used
  without one). It resolves by the linked provider identity, attaches a provider
  to an existing passwordless account with the same email, else creates one.
- 2FA no longer refuses "social login accounts" — it keys off whether the
  account has a password (a social account may now also have one).

**Breaking — passkey storage moved.** The passkey storage that shipped in 0.18 as
`hooks.storePasskeyChallenge` / `consumePasskeyChallenge` / `createPasskeyUser` /
`resolvePasskeyCredential` / `onPasskeyAuthenticated` / `userHasPasskey` moves to
a `PasskeyAdapter` on `config.passkey`, renamed `storeChallenge` /
`consumeChallenge` / `createUser` / `resolveCredential` / `onAuthenticated` /
`has` (plus new `list` / `add` / `remove`).

- `OAuthAccountAdapter` (`config.oauthAccounts`): `resolve` / `link` / `unlink` /
  `list`. New authed `oAuthLink` / `oAuthUnlink`.
- Add-passkey to an existing account: `auth.passkey.addOptions` / `addVerify` /
  `list` / `remove` (via the `passkey` adapter's `list` / `add` / `remove`).
- Passkey registration now fires `onUserCreated` (it didn't before), so
  provisioning is shared across password/OAuth/passkey signup instead of being
  re-implemented inside the passkey adapter. `onUserCreated`'s input type widened
  to include the passkey register input.
- `setPassword` for passwordless accounts (uses the User adapter).
- `countLoginMethods` / `assertKeepsLoginMethod` / `resolveLoginMethods`
  exported; every unlink/remove keeps at least one method.
- Prebuilt Prisma adapters `createPrismaOAuthAccountAdapter(prisma)` (fully
  generic) and `createPrismaPasskeyAdapter(prisma, { createUser, challenge })`
  (generic CRUD; you inject user-creation + the challenge store), mirroring
  `createPrismaDeviceAdapter`.
- Reference `Passkey` + `OAuthAccount` models in both schemas; README documented.
