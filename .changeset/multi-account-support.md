---
"@factiii/auth": minor
---

Add multi-account support to `@factiii/auth`.

A device can now hold a bundle of signed-in sessions and switch between them without re-authenticating. Behavior is unchanged by default; set `AuthConfig.maxAccounts > 1` to opt in.

**New config**

- `AuthConfig.maxAccounts?: number` — max sessions per device. Defaults to `1` (single-account, identical to prior behavior). `>1` enables the bundle.

**JWT shape**

- `JwtPayload` now carries `sessions: number[]` — the bundle of session IDs the device holds, with `id` pointing at the currently active one.
- `verifyAuthToken` / `decodeToken` normalize legacy tokens missing `sessions` to `[id]`, so existing tokens keep working across the rollout.
- `createAuthToken`'s `sessions` field is optional; defaults to `[id]`.

**New procedures (under `auth.multiAccount`)**

- `switchSession({ targetSessionId })` — make another session in the bundle active.
- `removeSession({ targetSessionId })` — revoke a session and drop it from the bundle; promotes the next session if the removed one was active, or clears cookies if it was the last.
- `clearBundle()` — revoke every session in the bundle ("log out of all accounts on this device").

**Auth guard changes**

- When the active session is revoked or missing, the guard now tries to promote another session from the bundle (rewriting cookies) and signals the rotation by throwing `UNAUTHORIZED` with message `ACTIVE_SESSION_SWITCHED` so clients can retry transparently.
- `TrpcContext` gains `bundleSessionIds?: number[]` for downstream procedures.

**Adapter change**

- `DatabaseAdapter.session.findManyByIds(ids)` is now **required**. Both `createPrismaAdapter` and `createDrizzleAdapter` implement it. Custom adapters must add it.

**New utilities**

- `issueAuthCookies(config, params)` — centralizes JWT + cookie issuance after sign-in / sign-up / oauth / magic-link, handles bundle append + cap enforcement + revoked-session pruning.
- `isUserInBundle(config, cookieHeader, userId)` — guards against signing the same user into one device twice. Used by base sign-in, OAuth, and magic-link procedures.
