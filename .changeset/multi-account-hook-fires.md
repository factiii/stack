---
"@factiii/auth": minor
---

Multi-account hook fires and logout consolidation.

- **Removed `auth.multiAccount.clearBundle`.** Use `auth.logout` instead — it now does the right thing for both single- and multi-account devices.
- **`auth.logout` revokes the whole bundle** when `ctx.bundleSessionIds` is present (previously revoked only the active session, leaving other bundle session rows alive in DB after cookies were cleared).
- **`auth.logout` now fires `onSessionRevoked`** per revoked session (was firing only `afterLogout`), matching every other revocation path.
- **`afterLogout` fires once for the active user**, not per session. The hook signature gained an optional 4th param — `otherSessions: Array<{ userId, sessionId, socketId }>` — listing bystander accounts in the bundle that were also revoked. Existing 3-arg handlers keep working unchanged.
- **`auth.logout` updates `user.isActive: false` for every unique userId in the bundle**, not just the active user.
- **`removeSession` fires `afterLogout` and flips `user.isActive: false`** when removing the last session in the bundle (matching `logout`'s precedent).
- **`removeSession` promotes the most-recently-added remaining session** when removing the active one (was promoting the oldest). Consistent with the authGuard fallback.
- **`removeSession` always re-fetches the new active session**, so the client cookie's `updatedAt` matches the DB on the first response (was forcing a redundant refresh on the next request when removing a non-active session).
- **Hook errors no longer abort the loop.** `onSessionRevoked` and `afterLogout` calls in both `logout` and `removeSession` are wrapped — a flaky listener can't leave the bundle half-revoked.
- **Already-revoked sessions are skipped** in `logout` and `removeSession`, so a session that was killed via another path (e.g. `revokeAllByUserId` from another device) won't get re-revoked or fire its hooks twice.
