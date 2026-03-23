# Contributing to @factiii/auth

## Quick Start

```bash
git clone https://github.com/factiii/auth.git
cd auth
pnpm install
./start.sh
```

`start.sh` spins up the PostgreSQL database in Docker, runs migrations, seeds test data, and starts both the API server and the test client app. You'll have:

- **Test client:** http://localhost:3456 (React app with signup, login, 2FA, password reset)
- **API server:** http://localhost:3457

### Seed accounts (created by `start.sh`)

| Username   | Email              | Password   | Notes          |
|------------|--------------------|------------|----------------|
| `testuser` | test@example.com   | `password123` | Basic account  |
| `adminuser`| admin@example.com  | `password123` | Has sessions   |
| `twofa_user`| twofa@example.com | `password123` | 2FA enabled    |

## Development Commands

```bash
pnpm dev            # Watch-mode build (rebuilds src/ on change)
pnpm build          # Production build
pnpm test           # Run unit tests
pnpm test:watch     # Run unit tests in watch mode
pnpm lint           # Lint src/
pnpm lint:fix       # Auto-fix lint issues
pnpm format:fix     # Format with Prettier
pnpm check-types    # Type check
```

## Testing

### Unit tests

Fast tests for utilities (JWT, password, TOTP, validators, cookies, browser detection, config):

```bash
pnpm test
```

### E2E tests

Full browser-based tests using Playwright. Requires Docker for the test database:

```bash
pnpm e2e            # Run all 215+ e2e tests
pnpm e2e:ui         # Run in Playwright UI mode (great for debugging)
```

## Project Structure

```
src/                  # Library source (this is what gets published)
  procedures/         # tRPC auth procedures
  middleware/          # Auth guard middleware
  utilities/          # JWT, password, TOTP, cookies, etc.
  types/              # TypeScript type definitions
  validators.ts       # Zod input schemas
  router.ts           # createAuthRouter entry point
tests/                # Unit tests (NOT published)
e2e/                  # E2E tests + test app (NOT published)
  app/                # React test client
  server/             # tRPC test server
  tests/              # Playwright test suites
bin/                  # CLI tool (npx @factiii/auth init)
prisma/               # Reference Prisma schema
```

Only `bin/`, `dist/`, `prisma/`, and `README.md` are included in the published npm package. Everything else (tests, e2e app, start.sh, seed, etc.) is for development only.

## Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `pnpm test` and `pnpm lint` to verify
4. Run `pnpm e2e` if your changes affect auth procedures
5. Open a PR against `main`

CI will run lint, type checking, and the full e2e test suite on your PR.
