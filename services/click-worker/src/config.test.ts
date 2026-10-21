import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config';

const base = {
  DATABASE_URL: 'postgresql://x',
  REDIS_URL: 'redis://x',
  VISITOR_HASH_SECRET: 'a-secret-that-is-long-enough',
};

describe('loadConfig', () => {
  it('fills defaults', () => {
    expect(loadConfig(base)).toMatchObject({
      healthPort: 4100,
      batchSize: 500,
      blockMs: 200,
      claimIdleMs: 30_000,
    });
  });

  it('refuses a short visitor secret, which would make the hash enumerable', () => {
    expect(() => loadConfig({ ...base, VISITOR_HASH_SECRET: 'short' })).toThrow(ConfigError);
  });

  it('reports every missing name at once', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL.*REDIS_URL.*VISITOR_HASH_SECRET/u);
  });

  it('refuses out-of-range numbers instead of clamping them', () => {
    expect(() => loadConfig({ ...base, WORKER_BATCH_SIZE: '0' })).toThrow(/WORKER_BATCH_SIZE/u);
    expect(() => loadConfig({ ...base, WORKER_HEALTH_PORT: 'abc' })).toThrow(/WORKER_HEALTH_PORT/u);
  });
});
