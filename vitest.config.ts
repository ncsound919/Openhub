import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'tests/e2e.test.ts'],
    // Real-IO suites (git worktrees, spawned CLIs, subprocess QA runs) routinely
    // exceed the 5s default under 55-file parallel load — a false timeout, not a
    // real failure. Assertions are unaffected.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Unit tests exercise the process runner, which emits receipts. Keep those
    // in-memory during tests so the suite never writes to data/receipts/.
    // Point the suite at a throwaway DB. Without this, tests/auth.test.ts ran
    // CREATE/INSERT/DELETE against the real data/openhub.db — `npm test`
    // mutated development data.
    env: {
      OPENHUB_RECEIPTS_DISABLE: '1',
      OPENHUB_DB_PATH: '.vitest/openhub-test.db',
    },
  },
});
