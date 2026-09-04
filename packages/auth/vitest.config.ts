import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Type assertions live in *.test-d.ts and are checked by tsc, not run.
    // The package tsconfig excludes tests from `check-types`, so without this
    // an `expectTypeOf` would compile-pass silently and guard nothing.
    typecheck: {
      enabled: true,
      include: ['tests/**/*.test-d.ts'],
      tsconfig: 'tsconfig.test.json',
    },
  },
});
