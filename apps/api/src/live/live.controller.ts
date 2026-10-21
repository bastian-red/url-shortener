/**
 * `GET /links/:id/live`: Server-Sent Events, one event per stored click.
 *
 * SSE rather than a WebSocket: the feed is one-way, it rides plain HTTP through
 * the web app's route handler (the browser never talks to this API), and the
 * browser's EventSource reconnects on its own. A comment line every 15 seconds
 * keeps proxies from closing an idle stream.
 */
import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { SkipThrottle } from '@nestjs/throttler';
import type { SessionUser } from '@links/shared';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { CurrentUser } from '../common/session.guard';
import { ZodPipe } from '../common/zod.pipe';
import { LinksService } from '../links/links.service';
import { LiveHub } from './live-hub';

const idParam = z
  .string()
  .min(20)
  .max(40)
  .regex(/^[a-z0-9]+$/u);

export const KEEPALIVE_MS = 15_000;

/** The ledger's feed covers the newest links only: one subscription each. */
export const LEDGER_LIVE_LINKS = 100;

function openStream(response: Response): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Tells nginx-style proxies not to buffer the stream.
    'x-accel-buffering': 'no',
  });
  response.write(': connected\n\n');
}

@Controller('links/:id/live')
export class LiveController {
  constructor(
    private readonly links: LinksService,
    private readonly hub: LiveHub,
  ) {}

  /**
   * Skips the throttler: one request holds the stream for minutes, so a
   * per-request budget measures nothing, and an EventSource that reconnects
   * after a deploy must not be refused for having connected before.
   */
  @SkipThrottle({ default: true, auth: true, create: true })
  @Get()
  async stream(
    @CurrentUser() user: SessionUser,
    @Param('id', new ZodPipe(idParam)) id: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    await this.links.owned(user, id);

    // Subscribe BEFORE the headers go out, so a client that sees the stream
    // open (EventSource `open`) is already receiving: a click in between would
    // otherwise be published to nobody.
    const unsubscribe = await this.hub.listen(id, (click) => {
      response.write(`id: ${click.id}\nevent: click\ndata: ${JSON.stringify(click)}\n\n`);
    });
    openStream(response);
    const keepalive = setInterval(() => response.write(': keepalive\n\n'), KEEPALIVE_MS);

    request.on('close', () => {
      clearInterval(keepalive);
      void unsubscribe();
    });
  }
}

/**
 * `GET /live`: one stream for the ledger, carrying clicks for every one of the
 * author's newest links, so the list can tick "+1" on each row without one
 * connection per row.
 */
@Controller('live')
export class LedgerLiveController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hub: LiveHub,
  ) {}

  @SkipThrottle({ default: true, auth: true, create: true })
  @Get()
  async stream(
    @CurrentUser() user: SessionUser,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const links = await this.prisma.client.link.findMany({
      where: { userId: user.id, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
      take: LEDGER_LIVE_LINKS,
    });
    const send = (click: { id: string }) =>
      response.write(`id: ${click.id}\nevent: click\ndata: ${JSON.stringify(click)}\n\n`);
    // Subscribed before the headers, for the same reason as above.
    const unsubscribers = await Promise.all(links.map((link) => this.hub.listen(link.id, send)));
    openStream(response);
    const keepalive = setInterval(() => response.write(': keepalive\n\n'), KEEPALIVE_MS);
    request.on('close', () => {
      clearInterval(keepalive);
      for (const unsubscribe of unsubscribers) void unsubscribe();
    });
  }
}
