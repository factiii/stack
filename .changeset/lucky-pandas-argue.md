---
'@factiii/auth': patch
---

Fix public routes rejecting a dead session, which locked browsers out

`authGuard` re-threw `UNAUTHORIZED` before it could reach the anonymous
fallback, so any session-integrity failure — revoked session, missing session,
userId mismatch, token predating the session, banned user, admin IP mismatch —
failed **every** route rather than only those requiring auth.

`login`, `logout` and `register` are built on the public procedure, so a revoked
session locked the browser out completely: it could not log in to replace the
dead cookie, nor log out to clear it. The auth cookie is `httpOnly`, so the
client could not clear it either. The only escape was waiting for the JWT to
expire or clearing cookies by hand.

Introduced in 0.10.0, which moved the re-throw above the `!meta?.authRequired`
fallback and made it unreachable. This restores the pre-0.10.0 ordering.
`FORBIDDEN` still propagates on every route, and procedures requiring auth still
reject a dead session exactly as before.
