/**
 * The application graph.
 *
 * Two global guards, both arranged so the unsafe direction is the one that needs
 * a decision:
 *
 * - **`SessionGuard` is global and runs first.** A route added next year is
 *   authenticated unless somebody writes `@Public()` on it; a guard applied per
 *   controller fails silently in the direction that matters. It runs before the
 *   throttler so signed-in calls are counted per user (`common/throttle.ts`).
 * - **`ThrottlerGuard` is global.** The general budget applies everywhere;
 *   `@Budget('auth')` and `@Budget('create')` ADD a stricter one to the routes
 *   that carry them. `/health`, `/status` and the live stream skip all of them.
 *
 * The throttler's storage is Redis rather than the default in-memory one,
 * because a limit that resets when a process restarts, and that counts
 * separately on each replica, is not a limit.
 */
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';

import { API_CONFIG, type ApiConfig } from './config/config';
import { AnalyticsController } from './analytics/analytics.controller';
import { AnalyticsService } from './analytics/analytics.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { DomainErrorFilter } from './common/domain-error.filter';
import { SessionGuard } from './common/session.guard';
import { throttlers } from './common/throttle';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { InfraModule } from './infra/infra.module';
import { RedisService } from './infra/redis.service';
import { LinksController } from './links/links.controller';
import { LinksService } from './links/links.service';
import { LedgerLiveController, LiveController } from './live/live.controller';
import { LiveHub } from './live/live-hub';
import { StatusController } from './status/status.controller';

@Module({
  imports: [
    InfraModule,
    ThrottlerModule.forRootAsync({
      inject: [API_CONFIG, RedisService],
      useFactory: (config: ApiConfig, redis: RedisService) => ({
        throttlers: throttlers(config),
        storage: new ThrottlerStorageRedisService(redis.client),
      }),
    }),
  ],
  controllers: [
    AuthController,
    LinksController,
    AnalyticsController,
    LiveController,
    LedgerLiveController,
    HealthController,
    StatusController,
  ],
  providers: [
    AuthService,
    LinksService,
    AnalyticsService,
    LiveHub,
    HealthService,
    // Registration order is execution order.
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
})
export class AppModule {}
