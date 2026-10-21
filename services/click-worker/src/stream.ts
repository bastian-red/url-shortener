import { CLICK_STREAM, clickEventSchema, type ClickEvent } from '@links/shared';

/**
 * Parsing what Redis returns. Pure, so a malformed entry is a unit test rather
 * than a production incident.
 */

export const GROUP = 'click-workers';
export const DEAD_LETTER_STREAM = `${CLICK_STREAM}:dead`;

export type RawEntry = [id: string, fields: string[]];

export type Parsed =
  | { ok: true; id: string; event: ClickEvent }
  | { ok: false; id: string; fields: Record<string, string>; reason: string };

export function fieldsToObject(fields: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) out[fields[i]!] = fields[i + 1]!;
  return out;
}

export function parseEntry([id, fields]: RawEntry): Parsed {
  const object = fieldsToObject(fields);
  const result = clickEventSchema.safeParse(object);
  if (!result.success) {
    return {
      ok: false,
      id,
      fields: object,
      reason: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }
  return { ok: true, id, event: result.data };
}

/** XREADGROUP's reply: [[stream, entries]] or null when BLOCK timed out. */
export function entriesOf(reply: unknown): RawEntry[] {
  if (!Array.isArray(reply)) return [];
  const out: RawEntry[] = [];
  for (const stream of reply as [string, RawEntry[]][]) {
    for (const entry of stream[1] ?? []) {
      // A pending entry that was trimmed away by MAXLEN comes back with null
      // fields. There is nothing left to process; it is acknowledged as dead.
      out.push([entry[0], entry[1] ?? []]);
    }
  }
  return out;
}
