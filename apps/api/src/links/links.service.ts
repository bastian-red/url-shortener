/**
 * Links: create, list, read, edit, delete. Every write reaches the redirect
 * cache before the request returns (`link-cache.ts`), which is what SPECS
 * outcome 5 means by "the very next request".
 */
import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { LINK_SLUG_UNIQUE, Prisma, violatedUniqueIndex } from '@links/db';
import {
  checkDestination,
  customSlugIssue,
  generateSlug,
  hostOf,
  MAX_ATTEMPTS,
} from '@links/link-rules';
import {
  CLICK_COUNT_PREFIX,
  DomainError,
  linkStatus,
  type CreateLinkInput,
  type Link,
  type LinkListItem,
  type SessionUser,
  type UpdateLinkInput,
} from '@links/shared';

import { API_CONFIG, type ApiConfig } from '../config/config';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';
import { writeThrough } from './link-cache';

const LINK_SELECT = {
  id: true,
  slug: true,
  url: true,
  title: true,
  createdAt: true,
  expiresAt: true,
  maxClicks: true,
  disabled: true,
  deletedAt: true,
} as const;

type LinkRow = Prisma.LinkGetPayload<{ select: typeof LINK_SELECT }>;

interface Counts {
  /** Human clicks Postgres has counted. */
  clicks: number;
  /** Every redirect granted: the Redis counter, or Postgres' humans + bots if Redis has none. */
  redirects: number;
}

@Injectable()
export class LinksService {
  private readonly shortHosts: string[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {
    this.shortHosts = [hostOf(config.shortBaseUrl), hostOf(config.appBaseUrl)];
  }

  async list(user: SessionUser, now = new Date()): Promise<LinkListItem[]> {
    const rows = await this.prisma.client.link.findMany({
      where: { userId: user.id, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: LINK_SELECT,
      take: 500,
    });
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const currentHour = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
    const since = new Date(currentHour - 23 * 3_600_000);
    const [totals, recent, counters] = await Promise.all([
      this.prisma.client.linkHour.groupBy({
        by: ['linkId'],
        where: { linkId: { in: ids } },
        _sum: { clicks: true, bots: true },
      }),
      this.prisma.client.linkHour.findMany({
        where: { linkId: { in: ids }, hour: { gte: since } },
        select: { linkId: true, hour: true, clicks: true },
      }),
      this.redis.client.mget(rows.map((r) => `${CLICK_COUNT_PREFIX}${r.slug}`)),
    ]);

    const totalBy = new Map(totals.map((t) => [t.linkId, t._sum]));
    const sparkBy = new Map<string, number[]>(ids.map((id) => [id, new Array<number>(24).fill(0)]));
    for (const h of recent) {
      const index = 23 - Math.round((currentHour - h.hour.getTime()) / 3_600_000);
      const spark = sparkBy.get(h.linkId);
      if (spark !== undefined && index >= 0 && index < 24) spark[index] = h.clicks;
    }

    return rows.map((row, i) => {
      const sum = totalBy.get(row.id);
      const clicks = sum?.clicks ?? 0;
      const counter = counters[i];
      const redirects =
        counter === null || counter === undefined ? clicks + (sum?.bots ?? 0) : Number(counter);
      return { ...this.toLink(row, { clicks, redirects }, now), last24h: sparkBy.get(row.id)! };
    });
  }

  async get(user: SessionUser, id: string, now = new Date()): Promise<Link> {
    const row = await this.owned(user, id);
    return this.toLink(row, await this.counts(row), now);
  }

  async create(user: SessionUser, input: CreateLinkInput, now = new Date()): Promise<Link> {
    const url = this.destination(input.url);
    const expiresAt = this.futureOrNull(input.expiresAt, now);

    if (input.slug !== undefined) {
      const issue = customSlugIssue(input.slug);
      if (issue === 'reserved') {
        throw new DomainError(
          'INVALID',
          `“${input.slug}” is reserved by the service. Pick another slug.`,
          { field: 'slug' },
        );
      }
      if (issue === 'grammar') {
        throw new DomainError(
          'INVALID',
          'Slugs are 3-64 letters, digits, - or _, starting with a letter or digit.',
          { field: 'slug' },
        );
      }
    }

    // A generated slug retries on collision; a custom one is the user's choice
    // and a collision is their answer, not ours to paper over.
    const attempts = input.slug === undefined ? MAX_ATTEMPTS : 1;
    for (let attempt = 1; ; attempt += 1) {
      const slug = input.slug ?? generateSlug((size) => randomBytes(size));
      try {
        const row = await this.prisma.client.$transaction(async (tx) => {
          const created = await tx.link.create({
            data: {
              userId: user.id,
              slug,
              url,
              title: input.title?.trim() || null,
              expiresAt,
              maxClicks: input.maxClicks ?? null,
            },
            select: LINK_SELECT,
          });
          // Inside the transaction: if Redis refuses, the link is not created
          // either, so there is never a link the redirect service cannot see.
          await writeThrough(
            this.redis.client,
            created.slug,
            created,
            this.config.linkCacheTtlSeconds,
          );
          return created;
        });
        return this.toLink(row, { clicks: 0, redirects: 0 }, now);
      } catch (error) {
        if (violatedUniqueIndex(error, LINK_SLUG_UNIQUE)) {
          if (input.slug !== undefined) {
            throw new DomainError(
              'CONFLICT',
              `The slug “${input.slug}” is taken. Slugs are never reused, even after a link is deleted.`,
              { field: 'slug' },
            );
          }
          if (attempt < attempts) continue;
        }
        throw error;
      }
    }
  }

  async update(
    user: SessionUser,
    id: string,
    input: UpdateLinkInput,
    now = new Date(),
  ): Promise<Link> {
    const url = input.url === undefined ? undefined : this.destination(input.url);
    const expiresAt =
      input.expiresAt === undefined ? undefined : this.futureOrNull(input.expiresAt, now);

    const row = await this.prisma.client.$transaction(async (tx) => {
      // FOR UPDATE: the cache write below happens while this row is locked, so
      // two concurrent edits reach Redis in the same order they commit. Without
      // the lock, edit A could commit first and write the cache last, leaving
      // the redirect serving A's URL after B has been saved.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM links WHERE id = ${id} AND user_id = ${user.id} AND deleted_at IS NULL FOR UPDATE`;
      if (locked.length === 0) throw new DomainError('NOT_FOUND', 'No such link.');

      if (input.maxClicks !== undefined && input.maxClicks !== null) {
        const current = await tx.link.findUniqueOrThrow({ where: { id }, select: LINK_SELECT });
        const { redirects } = await this.counts(current);
        if (input.maxClicks < redirects) {
          throw new DomainError(
            'UNPROCESSABLE',
            `This link has already been opened ${String(redirects)} times, so a limit of ${String(input.maxClicks)} would refuse it immediately. Turn it off instead, or set a limit of at least ${String(redirects)}.`,
            { field: 'maxClicks', redirects },
          );
        }
      }

      const updated = await tx.link.update({
        where: { id },
        data: {
          ...(url === undefined ? {} : { url }),
          ...(input.title === undefined ? {} : { title: input.title?.trim() || null }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
          ...(input.maxClicks === undefined ? {} : { maxClicks: input.maxClicks }),
          ...(input.disabled === undefined ? {} : { disabled: input.disabled }),
        },
        select: LINK_SELECT,
      });
      await writeThrough(this.redis.client, updated.slug, updated, this.config.linkCacheTtlSeconds);
      return updated;
    });
    return this.toLink(row, await this.counts(row), now);
  }

  /**
   * Soft delete. The row and its slug stay, so the slug can never be claimed
   * by somebody else (a printed QR code would start sending its scans to
   * them); the clicks stay too, until the account itself is deleted.
   */
  async remove(user: SessionUser, id: string): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM links WHERE id = ${id} AND user_id = ${user.id} AND deleted_at IS NULL FOR UPDATE`;
      if (locked.length === 0) throw new DomainError('NOT_FOUND', 'No such link.');
      const deleted = await tx.link.update({
        where: { id },
        data: { deletedAt: new Date() },
        select: LINK_SELECT,
      });
      await writeThrough(this.redis.client, deleted.slug, deleted, this.config.linkCacheTtlSeconds);
    });
  }

  /** The link if this user owns it. 404 otherwise: "not yours" and "no such link" look the same. */
  async owned(user: SessionUser, id: string): Promise<LinkRow> {
    const row = await this.prisma.client.link.findFirst({
      where: { id, userId: user.id, deletedAt: null },
      select: LINK_SELECT,
    });
    if (row === null) throw new DomainError('NOT_FOUND', 'No such link.');
    return row;
  }

  shortUrl(slug: string): string {
    return `${this.config.shortBaseUrl}/${slug}`;
  }

  private async counts(row: LinkRow): Promise<Counts> {
    const [sum, counter] = await Promise.all([
      this.prisma.client.linkHour.aggregate({
        where: { linkId: row.id },
        _sum: { clicks: true, bots: true },
      }),
      this.redis.client.get(`${CLICK_COUNT_PREFIX}${row.slug}`),
    ]);
    const clicks = sum._sum.clicks ?? 0;
    return {
      clicks,
      redirects: counter === null ? clicks + (sum._sum.bots ?? 0) : Number(counter),
    };
  }

  private toLink(row: LinkRow, counts: Counts, now: Date): Link {
    return {
      id: row.id,
      slug: row.slug,
      shortUrl: this.shortUrl(row.slug),
      url: row.url,
      title: row.title,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      maxClicks: row.maxClicks,
      disabled: row.disabled,
      clicks: counts.clicks,
      status: linkStatus(
        {
          disabled: row.disabled,
          expiresAt: row.expiresAt,
          maxClicks: row.maxClicks,
          redirects: counts.redirects,
        },
        now,
      ),
    };
  }

  private destination(raw: string): string {
    const checked = checkDestination(raw, this.shortHosts);
    if (!checked.ok)
      throw new DomainError('INVALID', checked.message, { field: 'url', issue: checked.issue });
    return checked.url;
  }

  private futureOrNull(value: string | null | undefined, now: Date): Date | null {
    if (value === undefined || value === null) return null;
    const date = new Date(value);
    if (date.getTime() <= now.getTime()) {
      throw new DomainError(
        'INVALID',
        'The expiry must be in the future. To stop a link now, turn it off.',
        { field: 'expiresAt' },
      );
    }
    return date;
  }
}
