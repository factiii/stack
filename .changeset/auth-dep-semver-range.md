---
"@factiii/stack": patch
---

fix: publish `@factiii/auth` as a real semver range and unblock publishing.

- Declare the `@factiii/auth` dependency as `workspace:^` instead of `workspace:*` so the published manifest ships `^x.y.z` rather than a pinned exact version. Previously the bare workspace protocol could leak into the published manifest, forcing consumers to add a `pnpm.overrides` entry to resolve `@factiii/auth`.
- Fix the `prepublish-check` guard, which read the on-disk `package.json` and so failed on the `workspace:` protocol on *every* publish — including correct `pnpm publish` runs (pnpm only resolves the protocol inside the packed tarball, not on disk). The check now skips the workspace assertion when the publisher is pnpm (via `npm_config_user_agent`) and still guards against an accidental `npm publish`.
