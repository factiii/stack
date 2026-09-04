---
'@factiii/auth': patch
---

Make `usernameMode` change the signup types, not just the runtime schema

`features.usernameMode` picked the signup schema at runtime from 0.20.0 on, but
the types were pinned to the username-required base whatever the mode said. A
consumer on `usernameMode: 'optional'` — the documented default — could not call
`register` without passing the username it had explicitly opted out of
collecting.

`createSchemas`, `createAuthRouter` and the router types now carry the mode as a
type parameter inferred from the config, so `register`'s input matches what the
schema actually validates: username optional under `'optional'`, required under
`'required'`. Consumers need no change.
