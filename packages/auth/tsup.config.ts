import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/validators.ts', 'src/drizzle.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: false,
  clean: true,
  external: ['@prisma/client', 'drizzle-orm', 'drizzle-orm/pg-core'],
});
