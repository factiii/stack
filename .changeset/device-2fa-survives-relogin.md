---
'@factiii/auth': patch
---

Stop a revoked session's 2FA secret from answering the login challenge, and
carry the live one onto the session that replaces it

In device mode the TOTP secret lives on `Session.twoFaSecret`, but it belongs to
the phone rather than to any one session of it. `findTwoFaSecretsByUserId` did
not filter revoked rows, so a secret from a device the user had deliberately
revoked — an old phone, a sold one, "log out everywhere" after a compromise —
still passed the 2FA challenge. Revoking a device did not revoke its second
factor. Present in every 0.x.

The filter alone would have turned that leak into a lockout, because nothing
carried the secret across a session replacement: `revokeDeviceSessionsForUser`
retires the session this device already held on every ordinary sign-in, so
filtering revoked rows would leave a re-logged-in user with no live secret at
all, and an account with no email on file with no way back in. So the two halves
are one change. `carryDeviceTwoFaSecret` moves the secret onto the replacement
in the password, OAuth and magic-link paths, and only then does the adapter
query — both the Prisma and Drizzle implementations — filter `revokedAt`.

It **moves** the secret rather than copying it, which the schema requires:
`Session.twoFaSecret` is `@unique`, so the donor and the recipient cannot hold
the same string even for the length of a transaction. `DeviceAuthAdapter` gains
an optional `moveTwoFaSecret`, implemented atomically by both shipped adapters
(clear the donor, then write the recipient, in one transaction) so a crash cannot
leave the secret on neither row. It is optional, not required, so an adapter
written against an earlier version still satisfies the interface; without it the
carry falls back to a clear-then-set pair, which is not atomic but fails in the
recoverable direction.

The carry is best-effort and never throws: losing a cached second factor is
recoverable, since the vault can mint a new one, while failing here would reject
a sign-in whose credentials have already been accepted. It does report a failure
rather than swallowing it. It is a no-op in standard mode, where the secret is on
the user row and no session replacement can touch it.

This also fixes an existing failure: a consumer that already filtered revoked
rows on its own approval path found no secret at all after a re-login, so
push approvals failed until the vault happened to re-materialize one.
