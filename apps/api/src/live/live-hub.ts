/**
 * One Redis subscriber per API process, fanned out to every open live feed.
 *
 * The worker publishes each stored click on `live:{linkId}`. A subscriber per
 * browser tab would be one Redis connection per viewer; instead this hub holds
 * one connection, subscribes to a channel when the first viewer of that link
 * arrives and unsubscribes when the last one leaves.
 *
 * A subscribed ioredis connection cannot run other commands, which is why this
 * is a second connection beside RedisService rather than the same one.
 */
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';

import { liveClickSchema, type LiveClick } from '@links/shared';

import { API_CONFIG, type ApiConfig } from '../config/config';

type Listener = (click: LiveClick) => void;

export const LIVE_CHANNEL_PREFIX = 'live:';

@Injectable()
export class LiveHub implements OnModuleInit, OnModuleDestroy {
  private readonly subscriber: Redis;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.subscriber = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: null });
    this.subscriber.on('error', (error) => {
      console.error('[api] live subscriber error', error);
    });
    this.subscriber.on('message', (channel: string, message: string) => {
      const linkId = channel.slice(LIVE_CHANNEL_PREFIX.length);
      const set = this.listeners.get(linkId);
      if (set === undefined) return;
      let click: LiveClick;
      try {
        // Parsed, not cast: this goes straight to a browser, and the parse is
        // the guarantee it carries only the fields the contract allows.
        click = liveClickSchema.parse(JSON.parse(message));
      } catch {
        return;
      }
      for (const listener of set) listener(click);
    });
  }

  async onModuleInit(): Promise<void> {
    await this.subscriber.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber.quit();
  }

  /** Returns the unsubscribe function. */
  async listen(linkId: string, listener: Listener): Promise<() => Promise<void>> {
    let set = this.listeners.get(linkId);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(linkId, set);
      await this.subscriber.subscribe(`${LIVE_CHANNEL_PREFIX}${linkId}`);
    }
    set.add(listener);
    return async () => {
      const current = this.listeners.get(linkId);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(linkId);
        await this.subscriber.unsubscribe(`${LIVE_CHANNEL_PREFIX}${linkId}`).catch(() => undefined);
      }
    };
  }

  /** For tests and /status: how many channels this process holds. */
  channelCount(): number {
    return this.listeners.size;
  }
}
