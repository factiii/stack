---
'@factiii/auth': minor
---

Configurable username requirement, plus `setUsername` to pick one later.

New `features.usernameMode: 'required' | 'optional'`, defaulting to
**`'optional'`**.

- `'optional'` (default): `register` accepts email + password alone and stores a
  null username; the account picks one later through the new authed
  `auth.setUsername` procedure. Right for email-first products, where making
  someone invent a unique handle before they can do anything is a tax on signup.
- `'required'`: an account cannot be created without a username, and
  `AuthUser.username` is never null in practice. Right for username-first
  products, where the username IS the identity — profile URLs, mentions,
  ownership checks.

**Breaking — the default changed.** Every release before this one required a
username unconditionally. A username-first consumer must now set
`usernameMode: 'required'` explicitly on upgrade; otherwise signup quietly stops
asking for one, and because `User.username` is usually `NOT NULL` the first such
signup fails at the database rather than at validation.

The mode drives the signup schema (`signupSchema` is the required base;
`signupSchemaOptionalUsername` its counterpart, both exported), so a missing
username is rejected by validation and the client sees a normal field error.
Login is unaffected — it has always accepted an email OR a username.

`AuthUser.username` and `CreateUserData.username` are typed `string | null` so
the optional mode is representable. Make the `username` column nullable if you
use the default; the reference Prisma schemas do.

Passkey ceremonies now bind to `username ?? email ?? user-<id>` instead of the
raw username. Under the optional mode a null-username account bound its
add-passkey challenge to `null`, so every such account shared one binding value
and a stolen `flowId` could attach a credential to a different account. The
authenticator also displays this value, so it is never blank.
