import { defineConfig } from 'vitest/config';

// Gate lane: pure functions only (enrichment, aggregation, config). The
// database and the stream are exercised by vitest.integration.config.ts.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
