import { createServer, type Server } from 'node:http';

import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import { CLICK_STREAM, type Health, type HealthCheck } from '@links/shared';

import { GROUP } from './stream';
import type { WorkerStats } from './worker';

/**
 * GET /health in the shared contract shape, and GET /stats with the pipeline
 * numbers the web app's /status page shows (stream lag, pending, dead letters).
 */

export interface PipelineStats {
  worker: WorkerStats;
  /** Entries in the stream not yet delivered to the group (XINFO GROUPS lag). */
  lag: number | null;
  /** Delivered, not yet acknowledged. */
  pending: number;
  streamLength: number;
}

async function timed(
  name: string,
  probe: () => Promise<unknown>,
  timeoutMs = 1000,
): Promise<HealthCheck> {
  const started = Date.now();
  try {
    await Promise.race([
      probe(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`timeout after ${String(timeoutMs)}ms`)), timeoutMs),
      ),
    ]);
    return { name, status: 'ok', latencyMs: Date.now() - started, detail: null };
  } catch (error) {
    return {
      name,
      status: 'fail',
      latencyMs: Date.now() - started,
      detail: (error as Error).message,
    };
  }
}

export async function healthReport(
  redis: Redis,
  pool: Pool,
  geoProblem: string | null,
  version: string,
  startedAt: number,
): Promise<Health> {
  const checks = await Promise.all([
    timed('redis', () => redis.ping()),
    timed('postgres', () => pool.query('SELECT 1')),
  ]);
  checks.push({
    name: 'geoip',
    status: geoProblem === null ? 'ok' : 'fail',
    latencyMs: 0,
    detail: geoProblem,
  });
  return {
    status: checks.every((c) => c.status === 'ok') ? 'ok' : 'degraded',
    service: 'click-worker',
    version,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    checks,
  };
}

export async function pipelineStats(redis: Redis, worker: WorkerStats): Promise<PipelineStats> {
  const [groups, length] = await Promise.all([
    redis.xinfo('GROUPS', CLICK_STREAM) as Promise<unknown[][]>,
    redis.xlen(CLICK_STREAM),
  ]);
  let lag: number | null = null;
  let pending = 0;
  for (const group of groups) {
    const info: Record<string, unknown> = {};
    for (let i = 0; i + 1 < group.length; i += 2) info[String(group[i])] = group[i + 1];
    if (info.name === GROUP) {
      pending = Number(info.pending ?? 0);
      lag = info.lag === null || info.lag === undefined ? null : Number(info.lag);
    }
  }
  return { worker, lag, pending, streamLength: length };
}

export function startHealthServer(
  port: number,
  report: () => Promise<Health>,
  stats: () => Promise<PipelineStats>,
): Server {
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') {
      report().then(
        (h) => send(h.status === 'ok' ? 200 : 503, h),
        (e: unknown) => send(500, { error: String(e) }),
      );
    } else if (req.method === 'GET' && req.url === '/stats') {
      stats().then(
        (s) => send(200, s),
        (e: unknown) => send(503, { error: String(e) }),
      );
    } else {
      send(404, { error: 'not found' });
    }
  });
  server.listen(port);
  return server;
}
