import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config';
import { BootError, assertConsistent } from './boot';

/**
 * A complete environment, so every test below changes exactly one thing and the
 * assertion is about that thing.
 */
function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    APP_VERSION: '0.1.0',
    API_PORT: '4000',
    DATABASE_URL: 'postgresql://links:links@localhost:5442/links',
    REDIS_URL: 'redis://localhost:6388',
    AUTH_SECRET: 'x'.repeat(32),
    APP_BASE_URL: 'http://localhost:3000',
    SHORT_BASE_URL: 'http://localhost:8080',
    REDIRECT_INTERNAL_URL: 'http://localhost:8080',
    WORKER_INTERNAL_URL: 'http://localhost:4100',
    RATE_LIMIT_GLOBAL: '240',
    RATE_LIMIT_AUTH: '5',
    RATE_LIMIT_CREATE: '30',
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('reads the documented environment', () => {
    const config = loadConfig(env());
    expect(config.port).toBe(4000);
    expect(config.shortBaseUrl).toBe('http://localhost:8080');
    expect(config.rateLimitCreate).toBe(30);
  });

  it('defaults the cache TTLs when they are blank, rather than reading 0', () => {
    const config = loadConfig(
      env({ LINK_CACHE_TTL_SECONDS: '', ANALYTICS_CACHE_TTL_SECONDS: ' ' }),
    );
    expect(config.linkCacheTtlSeconds).toBe(86_400);
    expect(config.analyticsCacheTtlSeconds).toBe(60);
  });

  it('strips a trailing slash from the short origin, so short URLs never get a double slash', () => {
    expect(loadConfig(env({ SHORT_BASE_URL: 'https://sho.rt/' })).shortBaseUrl).toBe(
      'https://sho.rt',
    );
  });

  // The precedence that lets a container runtime move the process without a
  // second image. Reversing it would make the compose override silently do
  // nothing.
  it('prefers PORT over API_PORT', () => {
    expect(loadConfig(env({ PORT: '4200' })).port).toBe(4200);
  });

  // `.env.example` ships PORT empty on purpose, so both services can run on one
  // host. An empty string must fall through, not fail the port regex.
  it('falls through an empty PORT to API_PORT', () => {
    expect(loadConfig(env({ PORT: '' })).port).toBe(4000);
    expect(loadConfig(env({ PORT: '   ' })).port).toBe(4000);
  });

  it('defaults NODE_ENV and APP_VERSION rather than refusing to start', () => {
    const config = loadConfig(env({ NODE_ENV: undefined, APP_VERSION: undefined }));
    expect(config.nodeEnv).toBe('development');
    expect(config.appVersion).toBe('0.0.0');
  });

  /**
   * The whole point of parsing at the edge: a fresh clone learns every missing
   * name at once instead of starting the process five times.
   */
  it('names every missing variable in one message', () => {
    const broken = env({ DATABASE_URL: undefined, REDIS_URL: undefined, AUTH_SECRET: undefined });
    expect(() => loadConfig(broken)).toThrow(ConfigError);
    try {
      loadConfig(broken);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('REDIS_URL');
      expect(message).toContain('AUTH_SECRET');
    }
  });

  it('refuses a short AUTH_SECRET, and says how short', () => {
    expect(() => loadConfig(env({ AUTH_SECRET: 'short' }))).toThrow(/at least 16 characters/u);
  });

  /**
   * `z.string().url()` on its own is not enough, and this is the case that
   * proves it. Measured before it was written:
   * `z.string().url().safeParse('localhost:3000').success` is `true`, because
   * `new URL('localhost:3000')` parses with protocol `localhost:` and path
   * `3000`, and the CORS origin would be one no browser sends.
   */
  it('refuses an APP_BASE_URL with no http(s) scheme', () => {
    expect(() => loadConfig(env({ APP_BASE_URL: 'localhost:3000' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ APP_BASE_URL: 'not a url' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ APP_BASE_URL: 'ftp://files.example.com' }))).toThrow(ConfigError);
    expect(loadConfig(env({ APP_BASE_URL: 'https://docs.example.com' })).appBaseUrl).toBe(
      'https://docs.example.com',
    );
  });

  it('refuses a non-numeric budget', () => {
    expect(() => loadConfig(env({ RATE_LIMIT_CREATE: '30 per minute' }))).toThrow(ConfigError);
  });
});

describe('assertConsistent', () => {
  it('accepts the documented defaults', () => {
    expect(() => {
      assertConsistent(loadConfig(env()));
    }).not.toThrow();
  });

  it('refuses an auth budget at or above the global one', () => {
    expect(() => {
      assertConsistent(loadConfig(env({ RATE_LIMIT_AUTH: '240' })));
    }).toThrow(BootError);
    expect(() => {
      assertConsistent(loadConfig(env({ RATE_LIMIT_AUTH: '600' })));
    }).toThrow(/credential-stuffing/u);
  });

  it('refuses a link-creation budget at or above the global one', () => {
    expect(() => {
      assertConsistent(loadConfig(env({ RATE_LIMIT_CREATE: '240' })));
    }).toThrow(/RATE_LIMIT_CREATE/u);
  });

  it('refuses a short origin equal to the app origin, where Next.js would answer every link', () => {
    expect(() => {
      assertConsistent(loadConfig(env({ SHORT_BASE_URL: 'http://localhost:3000/' })));
    }).toThrow(/same origin/u);
  });
});
