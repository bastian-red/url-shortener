import { join } from 'node:path';

/**
 * The worker's configuration, read once at boot.
 *
 * Every name here is declared in turbo.json; scripts/env-contract.mjs fails the
 * commit otherwise. `env` is a parameter so tests pass a fake environment.
 */
export interface WorkerConfig {
  databaseUrl: string;
  redisUrl: string;
  /** Secret the daily visitor-hash keys are derived from. Never stored. */
  visitorSecret: string;
  geoipDbPath: string;
  healthPort: number;
  batchSize: number;
  blockMs: number;
  /** A pending entry idle this long is assumed orphaned by a dead consumer and reclaimed. */
  claimIdleMs: number;
  version: string;
}

export class ConfigError extends Error {}

/**
 * The repo's `data/` directory, resolved from this file rather than from the
 * working directory: turbo starts the worker in `services/click-worker/`, a
 * container in `/app`, and a relative default would point somewhere different
 * in each.
 */
export const DEFAULT_GEOIP_DB_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'data',
  'dbip-city-lite.mmdb',
);

/**
 * Every read below is spelled `env.NAME` literally: scripts/env-contract.mjs
 * finds the names this process needs by scanning for that shape, and a computed
 * `env[name]` would be invisible to it.
 */
function int(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = value?.trim();
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${name}=${raw} must be an integer in ${String(min)}..${String(max)}`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = env.DATABASE_URL?.trim() ?? '';
  const redisUrl = env.REDIS_URL?.trim() ?? '';
  const visitorSecret = env.VISITOR_HASH_SECRET?.trim() ?? '';
  const problems: string[] = [];
  if (databaseUrl === '') problems.push('DATABASE_URL is required');
  if (redisUrl === '') problems.push('REDIS_URL is required');
  // The hash is only as private as this secret: with a short or guessable one,
  // enumerating 2^32 IPv4 addresses against a stored hash takes minutes.
  if (visitorSecret.length < 16)
    problems.push('VISITOR_HASH_SECRET must be at least 16 characters');
  if (problems.length > 0) throw new ConfigError(problems.join('; '));

  return {
    databaseUrl,
    redisUrl,
    visitorSecret,
    geoipDbPath: env.GEOIP_DB_PATH?.trim() || DEFAULT_GEOIP_DB_PATH,
    healthPort: int('WORKER_HEALTH_PORT', env.WORKER_HEALTH_PORT, 4100, 1, 65535),
    batchSize: int('WORKER_BATCH_SIZE', env.WORKER_BATCH_SIZE, 500, 1, 5000),
    blockMs: int('WORKER_BLOCK_MS', env.WORKER_BLOCK_MS, 200, 10, 10_000),
    claimIdleMs: int('WORKER_CLAIM_IDLE_MS', env.WORKER_CLAIM_IDLE_MS, 30_000, 100, 3_600_000),
    version: env.APP_VERSION?.trim() || 'dev',
  };
}
