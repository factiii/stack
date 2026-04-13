# @factiii/stack2 — Opinionated App Shell

## Status (2026-04)
**Not started.** Design intent only. No code exists in this repo yet.

## Vision
Invert the relationship between stack and consumer apps. A consumer repo contains only custom code; stack2 provides everything else fully configured. No opt-outs, no compatibility shims.

Consumer repo shape:
```
my-app/
├── stack.yml             # declares apps + auth mode
├── api/                  # custom tRPC routers + prisma models
├── client/               # Next.js app-router pages + components
├── mobile/               # Expo screens + components
└── shared/
    ├── core/             # types, validators, domains (api+client+mobile)
    ├── ui/               # React components, hooks, contexts (client+mobile)
    └── env/              # zod-validated env per target
```

No package.json per app, no Dockerfiles, no next.config, no tsconfig. stack2 owns all of it.

## Decisions locked in
1. Backend folder: `api/` (tRPC backend, shortest name)
2. No opt-outs: Next.js app-router, tRPC, Prisma (server), Drizzle (client SQLite), Postgres, Expo, Tailwind, jest
3. Auth: single enum `auth.mode: user | device` mapping to `@factiii/auth` modes
4. Auto-discovery: drop a file in `api/routers/`, it mounts; add models to `api/schema.prisma`, stack2 merges with base before `prisma generate`
5. Three-tier shared: `shared/core`, `shared/ui`, `shared/env` — stack2 ships base for each, consumer merges on top
6. Patterns absorbed from factiii: pnpm catalog versioning, single tsconfig/eslint preset, per-target env with zod, domains pattern, Prisma server / Drizzle client split, codegen to `.stack2/generated/` (gitignored)
7. No backwards compat with factiii's current layout — factiii migrates later
8. Build against empty testbed (`packages/stack2/test-fixture/`), not factiii
9. Complementary to `@factiii/stack` — stack2 = build-time + runtime app shell, stack = ops-time
10. Hybrid runtime+scaffold model: runtime imports for meaty stuff, scaffolded files only for things that must exist on disk (refreshed via `stack2 sync`)

## CLI surface
- `stack2 dev` — spins up api + client + mobile based on `stack.yml`
- `stack2 build` — builds declared apps
- `stack2 sync` — refreshes scaffolded files
- `stack2 deploy` — hands off to existing `@factiii/stack` for ops

## Phased plan
- [ ] **Phase 0:** create `packages/stack2/`, wire pnpm workspace, define `stack.yml` schema (zod), scaffold CLI entrypoint, create test fixture
- [ ] **Phase 1:** server (api) shell — Express + tRPC context + auth wiring + router auto-discovery
- [ ] **Phase 2:** Prisma base schema + merger (concatenate stack2 base + consumer schema before `prisma generate`)
- [ ] **Phase 3:** client shell — Next.js app-router, providers, auth pages, `next.config` re-export
- [ ] **Phase 4:** mobile shell — Expo, tRPC client, auth flows, navigation skeleton, EAS config
- [ ] **Phase 5:** wire `@factiii/stack` ops generators to stack2 defaults so `stack init` produces a stack2-shaped repo

## Open questions
- Testbed location: `packages/stack2/test-fixture/` inside this monorepo? (recommended)
- Router discovery: convention-based (`api/routers/*.ts` default export) vs explicit registry?

## Key context
- `@factiii/auth` standard + device mode split (commits `6d08838`, `c025d4b`) maps directly to stack2's `auth.mode` enum
- factiii repo at `~/factiii` is the reference for patterns but NOT the testbed
- factiii's `shared/all`, `shared/utils`, `shared/env` are the reference for what stack2 ships at each tier
