import { z } from 'zod';

/**
 * The small shapes every other contract is built from.
 *
 * Everything here is a zod schema with its TypeScript type derived by `z.infer`.
 * Never a hand-written interface beside a schema: the two drift, and the one
 * that drifts is always the one that is not validated.
 */

/** A cuid, which is what every `@id @default(cuid())` in the schema produces. */
export const idSchema = z
  .string()
  .min(20)
  .max(40)
  .regex(/^[a-z0-9]+$/u);

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const nameSchema = z.string().trim().min(1).max(80);

/**
 * At least 12 characters. Not a composition rule -- no "one digit, one symbol" --
 * because those push people towards `Password1!` and measurably lower entropy.
 * Length is the property that matters.
 */
export const passwordSchema = z.string().min(12).max(200);

/**
 * A short-link slug: the path segment after the short domain.
 *
 * Case-sensitive, like every major shortener: `aB3` and `ab3` are different
 * links. That is what makes a 7-character generated slug carry 62^7 (3.5e12)
 * values instead of 36^7 (7.8e10). Custom slugs may also use `-` and `_`, never
 * as the first character, so a slug can never look like a flag or a dotfile and
 * never contains a `/`, `.` or `%` that a proxy could normalise into another
 * path.
 *
 * Reserved words (`health`, `metrics`, ...) are refused by
 * `services/link-rules`, not here: this is the grammar, that is the policy.
 */
export const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/u;
export const slugSchema = z.string().regex(SLUG_PATTERN, 'a slug: 3-64 of A-Z a-z 0-9 - _');

/** An ISO 8601 instant. Always UTC on the wire; rendering picks a zone. */
export const instantSchema = z.string().datetime();

export type Id = z.infer<typeof idSchema>;
export type Slug = z.infer<typeof slugSchema>;
