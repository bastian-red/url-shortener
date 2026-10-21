/**
 * The API's own health report, shared by `GET /health` and `GET /status`.
 *
 * Two checks, each a real operation rather than a handle:
 *
 * - **Postgres** runs `SELECT 1`. A pool that believes it is connected to a
 *   server which closed the socket answers a liveness check perfectly and fails
 *   on the next query.
 * - **Redis** sends `PING`. It is not decorative here: every link write goes
 *   through to the redirect cache inside its transaction, so with Redis down no
 *   link can be created or edited, and the throttler's storage is Redis too.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Health, HealthCheck } from '@links/shared';

import { API_CONFIG, type ApiConfig } from '../config/config';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async report(): Promise<Health> {
    const checks = await Promise.all([
      timed('postgres', async () => {
        await this.prisma.client.$queryRaw`SELECT 1`;
      }),
      timed('redis', async () => {
        await this.redis.client.ping();
      }),
    ]);
    return {
      status: checks.every((check) => check.status === 'ok') ? 'ok' : 'degraded',
      service: 'api',
      version: this.config.appVersion,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      checks,
    };
  }
}

async function timed(name: string, run: () => Promise<void>): Promise<HealthCheck> {
  const started = Date.now();
  try {
    await run();
    return { name, status: 'ok', latencyMs: Date.now() - started, detail: null };
  } catch (error) {
    return {
      name,
      status: 'fail',
      latencyMs: Date.now() - started,
      // The message, not the stack. This body is read by whoever is running
      // dev-smoke and by the /status page, and a stack is neither.
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
