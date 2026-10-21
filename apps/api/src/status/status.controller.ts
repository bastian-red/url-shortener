/**
 * `GET /status`: the health of all three services and the click pipeline's
 * numbers, for the web app's /status page.
 *
 * Each sibling is asked for its own /health over HTTP rather than probed from
 * here: a redirect service whose Redis is fine but whose process is wedged
 * answers nothing, and that is exactly what this page must show. A sibling that
 * does not answer within the timeout is reported `unreachable`, not omitted.
 */
import { Controller, Get, Inject } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  healthSchema,
  type Health,
  type Pipeline,
  type Status,
  type Unreachable,
} from '@links/shared';

import { API_CONFIG, type ApiConfig } from '../config/config';
import { Public } from '../common/session.guard';
import { HealthService } from '../health/health.service';

const TIMEOUT_MS = 1500;

async function fetchJson(url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { status: response.status, body: await response.json() };
}

export async function sibling(
  service: 'redirect' | 'click-worker',
  base: string,
): Promise<Health | Unreachable> {
  try {
    const { body } = await fetchJson(`${base}/health`);
    const parsed = healthSchema.safeParse(body);
    if (parsed.success) return parsed.data;
    return { service, status: 'unreachable', detail: 'answered /health in an unexpected shape' };
  } catch (error) {
    // The error CLASS or code, never the message: a connection error's message
    // carries the internal host and port, and this endpoint is public.
    const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    const detail = typeof code === 'string' ? code : error instanceof Error ? error.name : 'Error';
    return { service, status: 'unreachable', detail };
  }
}

interface WorkerStatsBody {
  worker: {
    processed: number;
    inserted: number;
    duplicates: number;
    dead: number;
    lastBatchAt: number | null;
  };
  lag: number | null;
  pending: number;
  streamLength: number;
}

async function pipeline(base: string): Promise<Pipeline | null> {
  try {
    const { status, body } = await fetchJson(`${base}/stats`);
    if (status !== 200) return null;
    const stats = body as WorkerStatsBody;
    return {
      lag: stats.lag,
      pending: stats.pending,
      streamLength: stats.streamLength,
      processed: stats.worker.processed,
      inserted: stats.worker.inserted,
      duplicates: stats.worker.duplicates,
      dead: stats.worker.dead,
      lastBatchAt:
        stats.worker.lastBatchAt === null ? null : new Date(stats.worker.lastBatchAt).toISOString(),
    };
  } catch {
    return null;
  }
}

@Controller('status')
export class StatusController {
  constructor(
    private readonly health: HealthService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Public()
  @SkipThrottle({ default: true, auth: true, create: true })
  @Get()
  async status(): Promise<Status> {
    const [api, redirect, worker, numbers] = await Promise.all([
      this.health.report(),
      sibling('redirect', this.config.redirectInternalUrl),
      sibling('click-worker', this.config.workerInternalUrl),
      pipeline(this.config.workerInternalUrl),
    ]);
    return {
      checkedAt: new Date().toISOString(),
      services: [api, redirect, worker],
      pipeline: numbers,
    };
  }
}
