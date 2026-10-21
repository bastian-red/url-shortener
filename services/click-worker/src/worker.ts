import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import { CLICK_STREAM, type LiveClick } from '@links/shared';

import { enrich, type EnrichedClick, type GeoLookup } from './enrich';
import { DEAD_LETTER_STREAM, entriesOf, GROUP, parseEntry, type RawEntry } from './stream';
import { writeBatch } from './writer';

/**
 * The consumer loop.
 *
 * At-least-once delivery from the stream, made exactly-once in effect by the
 * idempotent write: an entry is acknowledged only after its transaction
 * commits, so a crash at any point leaves it pending, and whichever consumer
 * reclaims it (XAUTOCLAIM, after `claimIdleMs`) inserts nothing new.
 */

export interface WorkerDeps {
  redis: Redis;
  pool: Pool;
  geo: GeoLookup;
  secret: string;
  consumer: string;
  batchSize: number;
  blockMs: number;
  claimIdleMs: number;
  log: (event: string, data?: Record<string, unknown>) => void;
}

export interface WorkerStats {
  processed: number;
  inserted: number;
  duplicates: number;
  orphaned: number;
  dead: number;
  failedBatches: number;
  lastBatchAt: number | null;
}

export class ClickWorker {
  readonly stats: WorkerStats = {
    processed: 0,
    inserted: 0,
    duplicates: 0,
    orphaned: 0,
    dead: 0,
    failedBatches: 0,
    lastBatchAt: null,
  };
  private running = false;
  private stopped: Promise<void> = Promise.resolve();
  private lastClaim = 0;

  constructor(private readonly deps: WorkerDeps) {}

  async ensureGroup(): Promise<void> {
    try {
      // '0', not '$': a group created while clicks are already waiting must
      // process them, not skip to the end.
      await this.deps.redis.xgroup('CREATE', CLICK_STREAM, GROUP, '0', 'MKSTREAM');
    } catch (error) {
      if (!String(error).includes('BUSYGROUP')) throw error;
    }
  }

  start(): void {
    this.running = true;
    this.stopped = this.loop();
  }

  /** Finish the batch in hand, then return. */
  async stop(): Promise<void> {
    this.running = false;
    await this.stopped;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        if (Date.now() - this.lastClaim >= Math.min(this.deps.claimIdleMs, 15_000)) {
          this.lastClaim = Date.now();
          await this.reclaim();
        }
        const reply = await this.deps.redis.xreadgroup(
          'GROUP',
          GROUP,
          this.deps.consumer,
          'COUNT',
          this.deps.batchSize,
          'BLOCK',
          this.deps.blockMs,
          'STREAMS',
          CLICK_STREAM,
          '>',
        );
        await this.process(entriesOf(reply));
      } catch (error) {
        this.stats.failedBatches += 1;
        this.deps.log('batch_failed', { error: String(error) });
        // Back off: the entries stay pending and are retried by reclaim().
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  /** Take over entries another consumer read and never acknowledged. */
  async reclaim(): Promise<void> {
    let cursor = '0-0';
    do {
      const reply = (await this.deps.redis.xautoclaim(
        CLICK_STREAM,
        GROUP,
        this.deps.consumer,
        this.deps.claimIdleMs,
        cursor,
        'COUNT',
        this.deps.batchSize,
      )) as [string, RawEntry[], string[]?];
      cursor = reply[0];
      const entries = reply[1].map(([id, fields]) => [id, fields ?? []] as RawEntry);
      if (entries.length > 0) this.deps.log('reclaimed', { entries: entries.length });
      await this.process(entries);
      // XAUTOCLAIM also reports ids it deleted from the PEL because the entry
      // itself was trimmed (third element, Redis 7); nothing to do for those.
    } while (cursor !== '0-0' && this.running);
  }

  async process(entries: RawEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const good: EnrichedClick[] = [];
    const dead: { id: string; fields: Record<string, string>; reason: string }[] = [];
    for (const entry of entries) {
      const parsed = parseEntry(entry);
      if (parsed.ok) good.push(enrich(parsed.id, parsed.event, this.deps.geo, this.deps.secret));
      else dead.push(parsed);
    }

    const client = await this.deps.pool.connect();
    let result;
    try {
      result = await writeBatch(client, good);
    } finally {
      client.release();
    }

    const pipeline = this.deps.redis.pipeline();
    for (const d of dead) {
      // Kept, not discarded: a contract drift between the Go writer and this
      // reader shows up here as a growing stream with the reason attached.
      pipeline.xadd(
        DEAD_LETTER_STREAM,
        'MAXLEN',
        '~',
        '10000',
        '*',
        'id',
        d.id,
        'reason',
        d.reason,
        'raw',
        JSON.stringify(d.fields),
      );
    }
    const ids = entries.map(([id]) => id);
    pipeline.xack(CLICK_STREAM, GROUP, ...ids);
    // And delete. An acknowledged entry would otherwise sit in the stream -- and
    // in Redis' append-only file -- until MAXLEN trims it, carrying the visitor's
    // IP address the whole time. Processed means gone (SPECS outcome 7).
    pipeline.xdel(CLICK_STREAM, ...ids);
    for (const click of result.inserted) {
      pipeline.publish(`live:${click.linkId}`, JSON.stringify(toLive(click)));
    }
    await pipeline.exec();

    this.stats.processed += entries.length;
    this.stats.inserted += result.inserted.length;
    this.stats.duplicates += result.duplicates;
    this.stats.orphaned += result.orphaned;
    this.stats.dead += dead.length;
    this.stats.lastBatchAt = Date.now();
    if (dead.length > 0)
      this.deps.log('dead_letter', { entries: dead.length, reason: dead[0]?.reason });
  }
}

/** What a browser may see of a click: no IP, no visitor hash, no region or city. */
export function toLive(click: EnrichedClick): LiveClick {
  return {
    id: click.id,
    linkId: click.linkId,
    at: click.at.toISOString(),
    country: click.country,
    device: click.device,
    browser: click.browser,
    os: click.os,
    referrer: click.referrer,
    bot: click.isBot,
  };
}
