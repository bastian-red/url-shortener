/**
 * `dangerouslySetInnerHTML` does not appear in this app.
 *
 * The places it would be tempting are a destination URL or a referrer host, which
 * are strings a stranger controls. Both render as React text, and this gate
 * keeps it that way.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const WEB = join(__dirname, '..');

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/u.test(path) && !path.endsWith('.test.ts') ? [path] : [];
  });
}

describe('no raw HTML injection', () => {
  it('no component sets innerHTML', () => {
    const files = ['app', 'components', 'lib'].flatMap((dir) => walk(join(WEB, dir)));
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.filter((file) =>
      /dangerouslySetInnerHTML|\.innerHTML\s*=/u.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((file) => file.slice(WEB.length + 1))).toEqual([]);
  });
});
