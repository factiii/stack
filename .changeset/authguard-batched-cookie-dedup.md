---
"@factiii/auth": patch
---

Fix `authGuard` stacking duplicate `Set-Cookie` headers across batched tRPC procedures.

Batched procedures share a single `res`, so the auth/client cookies were appended once per procedure — stacking N copies of `Set-Cookie` (overflowing proxy buffers and causing 502s) and firing N redundant `getClientCookiePayload` queries, including on the slide path. The guard now checks whether the auth or client cookie has already been issued on the response and skips re-issuing it, so cookies are written at most once per request.
