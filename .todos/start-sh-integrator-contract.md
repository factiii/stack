# start.sh Integrator Contract

## Status (2026-04)
**Not started.** The start.sh scanfix works but consumer apps have no documented way to consume the exported values.

## Problem
The `start.sh` scanfix (`src/plugins/pipelines/factiii/scanfix/start-sh.ts`) injects an IP detection + PORT slot block between version-stamped markers. It exports `SYSTEM_IP / SLOT / CLIENT_PORT / SERVER_PORT`, but consumer apps (server CORS, client URLs, mobile `ios:device`) have no contract for reading those values. An inline comment references a `@shared/env` package that doesn't exist.

## Decisions made
- Fix at the start.sh layer, not a new package
- Delivery: `start.sh` is a regular fix in the factiii pipeline `fixes[]` (wired at `index.ts:304`). `npx stack` detects it; scan flags it as outdated when the marker's version doesn't match; `npx stack fix` re-injects. Version bumps propagate automatically.

## TODO
- [ ] Add `SYSTEM_IP=`, `CLIENT_PORT=`, `SERVER_PORT=` writes to `.env` next to the existing `PORT=` injection (idempotent, same sed/append pattern)
- [ ] Add an "Integrator contract" comment block inside the marker section listing the exported vars and how server/client/mobile should read them
- [ ] Test by running `npx stack` in a linked app repo — marker block should re-render with new content and `.env` should pick up the new keys

## Open questions
- Should we also write to `.env` so anything that already loads `.env` gets the values for free? (Leaning yes)
- Typed `stack-env.ts` helper for TS repos, or is `.env` + comments enough? (Leaning enough for now)
- How should the runtime CORS allowlist (localhost + LAN IP) be wired on the server side? Needs a convention, not just env values.

## Relevant files
- `src/plugins/pipelines/factiii/scanfix/start-sh.ts` — the scanfix
- `src/plugins/pipelines/factiii/index.ts:304` — where it's wired into `fixes[]`
