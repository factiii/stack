---
'@factiii/auth': minor
---

fix(auth): accept TOTP codes one time step either side of now

`verifyTotp` compared the submitted code against the current 30s step only, so
a client clock a few seconds off — or a user typing a code as it rolled over —
failed every attempt, indistinguishable from a wrong code. It now checks ±1
step per RFC 6238 §5.2, implementing the `window` parameter its JSDoc already
documented. Pass `window: 0` to restore the old strict behavior.
