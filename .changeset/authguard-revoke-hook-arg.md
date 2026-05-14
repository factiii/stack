---
"@factiii/auth": patch
---

Fix `authGuard.revokeSession` passing `userId` to `onSessionRevoked` where the hook expects `sessionId`.

The hook signature is `(sessionId, socketId, reason)` but the auth guard's revocation path was calling it with `session.userId` as the first argument. Consumers' `onSessionRevoked` handlers in this code path were receiving a userId where they expected a sessionId. Now passes `session.id` correctly.
