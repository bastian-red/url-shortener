/**
 * `GET /health`.
 *
 * 503 when any check fails, and the failing check is named in the body. Both
 * halves matter: `scripts/dev-smoke.sh` reads the body, because a 503 naming the
 * dead dependency is far more useful than a bare code, and
 * `infra/Dockerfile.api`'s HEALTHCHECK reads the status code, because a container
 * runtime cannot parse JSON.
 *
 * `@Public()`, because a probe that needs a credential is a probe a container
 * runtime cannot run. It reports dependency status and no data.
 */
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';

import { Public } from '../common/session.guard';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * `@SkipThrottle()` with every budget named. A container healthcheck probes
   * on a fixed interval from a fixed address; left under the global budget it
   * would eventually spend it and start receiving 429s, at which point the
   * runtime restarts a perfectly healthy process.
   */
  @Public()
  @SkipThrottle({ default: true, auth: true, create: true })
  @Get()
  async check(@Res() response: Response): Promise<void> {
    const body = await this.health.report();
    response
      .status(body.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
      .json(body);
  }
}
