import { hostname } from 'node:os';

import { Redis } from 'ioredis';
import { Pool } from 'pg';

import { loadConfig } from './config';
import { openGeo } from './geo';
import { healthReport, pipelineStats, startHealthServer } from './health';
import { ClickWorker } from './worker';
import { ensurePartitions, pruneVisitorSets } from './writer';

/** One JSON line per event, so the logs are greppable and parseable alike. */
function log(event: string, data: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), service: 'click-worker', event, ...data })}\n`,
  );
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const config = loadConfig();
  const geo = await openGeo(config.geoipDbPath);
  if (geo.problem !== null) log('geoip_unavailable', { detail: geo.problem });

  // Prisma's `?schema=public` is not a libpq parameter; pg ignores unknown
  // query parameters, so the same DATABASE_URL works here unchanged.
  const pool = new Pool({ connectionString: config.databaseUrl, max: 4 });
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });

  const maintenance = async () => {
    const client = await pool.connect();
    try {
      const created = await ensurePartitions(client, new Date());
      const pruned = await pruneVisitorSets(client, new Date());
      log('maintenance', { partitionsCreated: created, visitorSetsPruned: pruned });
    } finally {
      client.release();
    }
  };
  await maintenance();
  const maintenanceTimer = setInterval(() => {
    maintenance().catch((error: unknown) => log('maintenance_failed', { error: String(error) }));
  }, 3_600_000);

  const worker = new ClickWorker({
    redis,
    pool,
    geo: geo.lookup,
    secret: config.visitorSecret,
    // Unique per process: a restarted worker must be a NEW consumer, so the
    // entries its predecessor held are reclaimed by XAUTOCLAIM rather than
    // silently inherited.
    consumer: `${hostname()}-${String(process.pid)}`,
    batchSize: config.batchSize,
    blockMs: config.blockMs,
    claimIdleMs: config.claimIdleMs,
    log,
  });
  await worker.ensureGroup();
  worker.start();

  const statsTimer = setInterval(() => log('stats', { ...worker.stats }), 60_000);
  const server = startHealthServer(
    config.healthPort,
    () => healthReport(redis, pool, geo.problem, config.version, startedAt),
    () => pipelineStats(redis, worker.stats),
  );
  log('started', {
    healthPort: config.healthPort,
    batchSize: config.batchSize,
    geoip: geo.problem === null,
  });

  const shutdown = async (signal: string) => {
    log('stopping', { signal });
    clearInterval(maintenanceTimer);
    clearInterval(statsTimer);
    server.close();
    await worker.stop();
    await Promise.allSettled([pool.end(), redis.quit()]);
    log('stopped', { ...worker.stats });
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  log('fatal', { error: String(error) });
  process.exit(1);
});
