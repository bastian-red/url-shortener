import { z } from 'zod';

import { idSchema, instantSchema, slugSchema } from './primitives';

/**
 * Link contracts: what the web app sends to `apps/api` and what it gets back.
 *
 * The redirect service never sees these. It reads the cache record described by
 * `contracts/link-cache.schema.json`, which is a deliberately smaller shape: the
 * hot path carries only what it needs to answer one request.
 */

/** Longest destination accepted. Browsers handle more; nobody shares more. */
export const MAX_URL_LENGTH = 2048;
/** A click limit beyond this is not a limit. */
export const MAX_CLICK_LIMIT = 10_000_000;

export const destinationSchema = z.string().trim().min(1).max(MAX_URL_LENGTH);

export const createLinkSchema = z.object({
  url: destinationSchema,
  /** Omitted: the API generates a 7-character base62 slug. */
  slug: slugSchema.optional(),
  title: z.string().trim().max(120).optional(),
  expiresAt: instantSchema.nullable().optional(),
  maxClicks: z.number().int().positive().max(MAX_CLICK_LIMIT).nullable().optional(),
});

/**
 * Every field optional, and `null` means "clear it". The slug is not editable:
 * a printed QR code points at it, so renaming would break every copy already
 * in the world.
 */
export const updateLinkSchema = z
  .object({
    url: destinationSchema.optional(),
    title: z.string().trim().max(120).nullable().optional(),
    expiresAt: instantSchema.nullable().optional(),
    maxClicks: z.number().int().positive().max(MAX_CLICK_LIMIT).nullable().optional(),
    disabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'nothing to update');

export const LINK_STATUSES = [
  'active',
  'expiring',
  'expired',
  'limit_reached',
  'disabled',
] as const;
export const linkStatusSchema = z.enum(LINK_STATUSES);

export const linkSchema = z.object({
  id: idSchema,
  slug: slugSchema,
  shortUrl: z.string().url(),
  url: z.string(),
  title: z.string().nullable(),
  createdAt: instantSchema,
  expiresAt: instantSchema.nullable(),
  maxClicks: z.number().int().positive().nullable(),
  disabled: z.boolean(),
  /** Human clicks counted by the analytics pipeline (bots excluded). */
  clicks: z.number().int().nonnegative(),
  status: linkStatusSchema,
});

export const linkListItemSchema = linkSchema.extend({
  /** 24 hourly buckets, oldest first, ending with the current hour. */
  last24h: z.array(z.number().int().nonnegative()).length(24),
});

export const linkListSchema = z.object({
  items: z.array(linkListItemSchema),
});

export type CreateLinkInput = z.infer<typeof createLinkSchema>;
export type UpdateLinkInput = z.infer<typeof updateLinkSchema>;
export type LinkStatus = z.infer<typeof linkStatusSchema>;
export type Link = z.infer<typeof linkSchema>;
export type LinkListItem = z.infer<typeof linkListItemSchema>;
export type LinkList = z.infer<typeof linkListSchema>;
