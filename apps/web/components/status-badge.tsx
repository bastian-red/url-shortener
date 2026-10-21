import type { LinkStatus } from '@links/shared';

import { STATUS_DISPLAY } from '../lib/format';

/** A status as a glyph and a word; the colour is the third channel, never the only one. */
export function StatusBadge({ status }: { readonly status: LinkStatus }) {
  const display = STATUS_DISPLAY[status];
  return (
    <span className="status" data-tone={display.tone} data-status={status}>
      <span className="status-glyph" aria-hidden="true">
        {display.glyph}
      </span>
      {display.word}
    </span>
  );
}
