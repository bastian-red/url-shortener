/**
 * `/links`: the signed-in author's links. Every route is authenticated by the
 * global guard; ownership is enforced in the service (404 for "not yours").
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  createLinkSchema,
  updateLinkSchema,
  type CreateLinkInput,
  type Link,
  type LinkList,
  type SessionUser,
  type UpdateLinkInput,
} from '@links/shared';
import type { Response } from 'express';
import { z } from 'zod';

import { CurrentUser } from '../common/session.guard';
import { Budget } from '../common/throttle';
import { ZodPipe } from '../common/zod.pipe';
import { LinksService } from './links.service';
import { renderQr } from './qr';

const idParam = z
  .string()
  .min(20)
  .max(40)
  .regex(/^[a-z0-9]+$/u);

const qrQuery = z.object({
  format: z.enum(['svg', 'png']).default('svg'),
  size: z
    .string()
    .regex(/^\d+$/u)
    .transform(Number)
    .pipe(z.number().int().min(128).max(2048))
    .default('512'),
  download: z.enum(['0', '1']).default('0'),
});

@Controller('links')
export class LinksController {
  constructor(private readonly links: LinksService) {}

  @Get()
  async list(@CurrentUser() user: SessionUser): Promise<LinkList> {
    return { items: await this.links.list(user) };
  }

  /** The create budget is ON TOP of the general one: link creation is the spam surface. */
  @Budget('create')
  @Post()
  create(
    @CurrentUser() user: SessionUser,
    @Body(new ZodPipe(createLinkSchema)) input: CreateLinkInput,
  ): Promise<Link> {
    return this.links.create(user, input);
  }

  @Get(':id')
  get(
    @CurrentUser() user: SessionUser,
    @Param('id', new ZodPipe(idParam)) id: string,
  ): Promise<Link> {
    return this.links.get(user, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: SessionUser,
    @Param('id', new ZodPipe(idParam)) id: string,
    @Body(new ZodPipe(updateLinkSchema)) input: UpdateLinkInput,
  ): Promise<Link> {
    return this.links.update(user, id, input);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  remove(
    @CurrentUser() user: SessionUser,
    @Param('id', new ZodPipe(idParam)) id: string,
  ): Promise<void> {
    return this.links.remove(user, id);
  }

  @Get(':id/qr')
  async qr(
    @CurrentUser() user: SessionUser,
    @Param('id', new ZodPipe(idParam)) id: string,
    @Query(new ZodPipe(qrQuery)) query: z.infer<typeof qrQuery>,
    @Res() response: Response,
  ): Promise<void> {
    const link = await this.links.owned(user, id);
    const body = await renderQr(this.links.shortUrl(link.slug), query.format, query.size);
    response.setHeader('content-type', query.format === 'svg' ? 'image/svg+xml' : 'image/png');
    response.setHeader('cache-control', 'private, max-age=3600');
    if (query.download === '1') {
      response.setHeader(
        'content-disposition',
        `attachment; filename="${link.slug}.${query.format}"`,
      );
    }
    response.send(body);
  }
}
