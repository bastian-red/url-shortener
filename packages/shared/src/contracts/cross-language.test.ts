/**
 * The cross-language contract, held from the TypeScript side.
 *
 * `services/redirect` is Go, so it cannot import these zod schemas. Both sides
 * test against `contracts/*.schema.json` and one golden fixture each instead.
 * This file proves the TypeScript half: the fixture parses with zod, validates
 * with the JSON Schema, and the two schemas name exactly the same fields. The Go
 * half is `services/redirect/internal/contract/contract_test.go`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import type { ZodObject, ZodRawShape } from 'zod';

import { clickEventSchema, linkCacheSchema } from './click-event';
import { healthSchema } from './health';

const ROOT = join(__dirname, '..', '..', '..', '..', 'contracts');
const read = (file: string): unknown => JSON.parse(readFileSync(join(ROOT, file), 'utf8'));

const CASES = [
  ['click-event', clickEventSchema],
  ['link-cache', linkCacheSchema],
  ['health', healthSchema],
] as const;

describe.each(CASES)('%s', (name, zodSchema) => {
  const jsonSchema = read(`${name}.schema.json`) as {
    properties: Record<string, unknown>;
    required: string[];
  };
  const fixture = read(`fixtures/${name}.json`);
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(jsonSchema);

  it('the golden fixture validates against the JSON Schema', () => {
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
  });

  it('the golden fixture parses with the zod schema', () => {
    const parsed = zodSchema.safeParse(fixture);
    expect(parsed.success, parsed.success ? '' : parsed.error.message).toBe(true);
  });

  it('both schemas declare the same fields, all required', () => {
    const zodKeys = Object.keys((zodSchema as unknown as ZodObject<ZodRawShape>).shape).sort();
    expect(Object.keys(jsonSchema.properties).sort()).toEqual(zodKeys);
    expect([...jsonSchema.required].sort()).toEqual(zodKeys);
  });

  it('an extra field is refused by both', () => {
    const extra = { ...(fixture as object), sneaky: 'x' };
    expect(validate(extra)).toBe(false);
    expect(zodSchema.safeParse(extra).success).toBe(false);
  });
});
