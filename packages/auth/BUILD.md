# Building @factiii/auth

Authentication library for tRPC with JWT, OAuth, 2FA, and session management.

## Prerequisites

- Node.js >= 18
- pnpm
- Install from repo root: `pnpm install`

## Build

```bash
# From repo root
pnpm build:auth

# Or from this directory
pnpm build
```

Build uses `tsup` — outputs ESM + CJS to `dist/`.

## Test

```bash
# From repo root
pnpm test:auth

# Or from this directory
pnpm test
```

Tests use `vitest`.

## E2E Tests

Requires Docker (for Postgres):

```bash
cd packages/auth
pnpm e2e
```

## Lint & Format

```bash
pnpm lint
pnpm format
```

## Publish

```bash
npm publish
```

Publishes as `@factiii/auth` to npm. The `prepublishOnly` script runs the build automatically.
