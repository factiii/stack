---
'@factiii/auth': minor
---

Sign-in no longer rejects a device that already holds a session for the same account. **Behavior change** — the `BAD_REQUEST: "You are already signed in as this account on this device."` error is gone from `login`, `oAuthLogin`, and magic-link verification.

**Why.** The check ran *after* the password and the 2FA code had both verified, so it rejected callers who had just proven exactly who they were. That made it unrecoverable rather than merely annoying: no credential and no TOTP code could get past it, and any client whose view of the session had drifted from the cookie was locked out until the user found and cleared cookies by hand. Consumers were reduced to string-matching the message client-side and adopting the session themselves.

**What.** The three sign-in paths now call `revokeDeviceSessionsForUser`, which retires the sessions this device holds for that account and lets the sign-in proceed with a fresh one:

- Revokes rather than reuses. `issueAuthCookies` drops the previous bundle entry at `maxAccounts: 1`, so reusing would leave the old row un-revoked in the database and reachable by nothing.
- Leaves other accounts in the bundle alone — signing in as one user on a multi-account device does not sign the others out.
- Skips sessions already revoked elsewhere, so hooks don't fire twice for one logout.
- Fires `onSessionRevoked(sessionId, socketId, 'Replaced by a new sign-in on this device')` per revoked session, wrapped, so a throwing listener cannot abort a sign-in half-way.

No config flag: every one of these paths is reached only after identity is proven, so there is no case where refusing is the better answer.

**Migration.** If you match on that error message to recover the session client-side, delete that branch — the login call now simply succeeds and sets cookies. `isUserInBundle` remains exported for anyone using it directly; it is just no longer called on the sign-in paths.

**Still open.** Changing `cookieSettings.clientDomain` is not self-healing: browsers holding the cookie under the old scope keep it, because the `Cookie:` header carries no `Domain` attribute for the server to compare. Renaming `storageKeys.clientToken` forces the re-issue in the meantime. Tracked in `packages/auth/TODO.md`.
