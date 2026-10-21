import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  analyticsQuerySchema,
  type Analytics,
  type AnalyticsQuery,
  type SessionUser,
} from '@links/shared';
import { z } from 'zod';

import { CurrentUser } from '../common/session.guard';
import { ZodPipe } from '../common/zod.pipe';
import { AnalyticsService } from './analytics.service';

const idParam = z
  .string()
  .min(20)
  .max(40)
  .regex(/^[a-z0-9]+$/u);

@Controller('links/:id/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get()
  report(
    @CurrentUser() user: SessionUser,
    @Param('id', new ZodPipe(idParam)) id: string,
    @Query(new ZodPipe(analyticsQuerySchema)) query: AnalyticsQuery,
  ): Promise<Analytics> {
    return this.analytics.report(user, id, query);
  }
}
