import { defineConfig } from 'drizzle-kit'

// Temporary config for baseline-reset introspect/generate verification.
// Writes to $INTROSPECT_OUT (outside db/migrations) so it never touches
// the real migration directory. Safe to delete after Phase A is done.
export default defineConfig({
  dialect: 'postgresql',
  schema: './schema/index.ts',
  out: process.env.INTROSPECT_OUT!,
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  casing: 'snake_case',
  verbose: true,
})
