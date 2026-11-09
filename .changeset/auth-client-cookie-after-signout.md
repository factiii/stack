---
'@factiii/auth': minor
---

A signed-in request still in flight at sign-out can answer after it and write the readable client cookie back, so the browser read a signed-in visitor until its next call returned 401. Sign-out can't stop that response, so it now leaves a marker instead:

- The client cookie payload carries `issuedAt` (ms), stamped by `setAuthCookies` and `setClientCookie`.
- `clearAuthCookies` also writes `<clientToken>-out=<ms>`, readable, on the client cookie's domain, for the cookie's `maxAge`.
- `readClientSession` / `hasClientSession` (`@factiii/auth/browser`) ignore a client cookie issued before that marker. A cookie without `issuedAt` (written by an older version) beside a marker reads as signed out; with no marker, nothing changes.
- New exports: `signedOutCookieName` (server and browser), and `readSignedOutAt` / `isIssuedAfterSignOut` (browser) for apps that read the client cookie themselves.

Apps that re-scope auth cookies by name (for example to a second domain) must re-scope `<clientToken>-out` too.
