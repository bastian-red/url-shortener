import { defineConfig } from 'vitest/config';

// Integration lane: real Postgres and Redis, run by scripts/integration.sh.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
