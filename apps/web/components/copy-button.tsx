'use client';

import { useState } from 'react';

/**
 * Copy a value to the clipboard and say so, in words, in a live region: a
 * button whose only feedback is an icon change tells a screen reader nothing.
 */
export function CopyButton({
  value,
  label = 'Copy',
}: {
  readonly value: string;
  readonly label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="button button-small"
      data-copy={value}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          },
          () => setCopied(false),
        );
      }}
    >
      <span aria-live="polite">{copied ? 'Copied ✓' : label}</span>
    </button>
  );
}
