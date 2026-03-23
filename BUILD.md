# Building @factiii/stack

Monorepo containing two npm packages:
- `@factiii/stack` — Infrastructure CLI (root)
- `@factiii/auth` — Authentication library (`packages/auth/`)

## Prerequisites

- Node.js >= 18
- pnpm

## Install

```bash
pnpm install
```

## Build

```bash
# Stack only
pnpm build

# Auth only
pnpm build:auth

# Both
pnpm build:all
```

## Test

```bash
# Stack only
pnpm test

# Auth only
pnpm test:auth

# Both
pnpm test:all
```

## Typecheck

```bash
pnpm typecheck
```

## Publish

Each package publishes independently to npm:

```bash
# Stack (from repo root)
npm publish

# Auth
cd packages/auth && npm publish
```

## Local Testing

Link stack globally for testing in app repos:

```bash
pnpm link --global
# Then in your app repo:
pnpm link --global @factiii/stack
```
