'use client';

import { useActionState, useEffect, useRef, useState } from 'react';

import type { CreateState } from '../app/(app)/actions';
import { looksLikeUrl } from '../lib/paste';
import { CopyButton } from './copy-button';

interface Props {
  readonly action: (previous: CreateState, form: FormData) => Promise<CreateState>;
  readonly shortOrigin: string;
}

/**
 * Paste, Enter, done: the one action this product exists for, so it sits at
 * the top of the first page with the input focused. The options (custom slug,
 * expiry, click limit) are one disclosure away and never in the way.
 *
 * Two actions, measured by `e2e/tests/links.spec.ts`: a paste (anywhere on the
 * page, not only into the field) and Enter. The new short link is then already
 * on the clipboard; the strip says so in words, and keeps a Copy button for
 * when the browser refused the write (no permission, or the action outlived
 * the paste's user activation).
 *
 * A server action through `useActionState`, so it works as a plain POST before
 * hydration and the result renders in place after.
 */
export function CommandBar({ action, shortOrigin }: Props) {
  const [state, formAction, pending] = useActionState(action, {
    error: null,
    field: null,
    created: null,
  });
  const form = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const offset = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);

  useEffect(() => {
    if (offset.current) offset.current.value = String(new Date().getTimezoneOffset());
  }, []);

  useEffect(() => {
    if (!state.created) return;
    form.current?.reset();
    setCopied(null);
    let cancelled = false;
    navigator.clipboard.writeText(state.created.shortUrl).then(
      () => !cancelled && setCopied('yes'),
      () => !cancelled && setCopied('no'),
    );
    return () => {
      cancelled = true;
    };
  }, [state.created]);

  // Paste anywhere: a URL pasted while focus is not in a text field lands in
  // the command bar and is shortened. Pasting into a field keeps its meaning.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const text = event.clipboardData?.getData('text/plain').trim() ?? '';
      if (!looksLikeUrl(text) || !input.current || !form.current) return;
      event.preventDefault();
      input.current.value = text;
      input.current.focus();
      form.current.requestSubmit();
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);

  const invalid = (field: string) => (state.field === field ? true : undefined);

  return (
    <section className="command" aria-labelledby="command-title">
      <div className="command-head">
        <h1 id="command-title" className="command-title">
          Shorten a link
        </h1>
        <span className="command-hint">Paste anywhere on this page, then press Enter</span>
      </div>
      <form ref={form} action={formAction} className="command-form" noValidate>
        <input ref={offset} type="hidden" name="tzOffset" defaultValue="0" />
        <div className="command-row">
          <label className="visually-hidden" htmlFor="url">
            Destination URL
          </label>
          <input
            ref={input}
            id="url"
            name="url"
            className="field-input command-input"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste a long URL…"
            required
            autoFocus
            aria-invalid={invalid('url')}
            aria-describedby={state.error ? 'command-error' : undefined}
          />
          <button className="button button-primary" type="submit" disabled={pending}>
            {pending ? 'Shortening…' : 'Shorten'}
          </button>
        </div>
        <details className="command-options">
          <summary>Custom slug, title, expiry and click limit</summary>
          <div className="command-options-grid">
            <label className="field">
              <span className="field-label">Custom slug</span>
              <span className="slug-input">
                <span className="slug-prefix" aria-hidden="true">
                  {shortOrigin.replace(/^https?:\/\//u, '')}/
                </span>
                <input
                  className="field-input"
                  name="slug"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="spring-sale"
                  aria-invalid={invalid('slug')}
                />
              </span>
              <span className="field-hint">
                Leave blank for a random 7-character slug. Case-sensitive.
              </span>
            </label>
            <label className="field">
              <span className="field-label">Title</span>
              <input
                className="field-input"
                name="title"
                type="text"
                maxLength={120}
                placeholder="For your own list"
              />
            </label>
            <label className="field">
              <span className="field-label">Expires</span>
              <input
                className="field-input"
                name="expiresAt"
                type="datetime-local"
                aria-invalid={invalid('expiresAt')}
              />
              <span className="field-hint">After this, visitors get “This link has expired”.</span>
            </label>
            <label className="field">
              <span className="field-label">Click limit</span>
              <input
                className="field-input"
                name="maxClicks"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                placeholder="No limit"
                aria-invalid={invalid('maxClicks')}
              />
            </label>
          </div>
        </details>
        {state.error === null ? null : (
          <p id="command-error" className="form-error" role="alert">
            {state.error}
          </p>
        )}
      </form>
      {state.created === null ? null : (
        <div className="created" role="status" data-copied={copied ?? undefined}>
          <p className="created-label">
            {copied === 'yes'
              ? 'Short link ready, and copied to your clipboard'
              : copied === 'no'
                ? 'Short link ready. Copy it below.'
                : 'Short link ready'}
          </p>
          <div className="created-route">
            <code className="created-url" data-testid="created-short-url" translate="no">
              {state.created.shortUrl}
            </code>
            <span className="created-dest" title={state.created.url} translate="no">
              <span className="route-line" aria-hidden="true" />
              <span className="visually-hidden">Goes to </span>
              {state.created.url.replace(/^https?:\/\//u, '')}
            </span>
          </div>
          <div className="created-actions">
            <CopyButton value={state.created.shortUrl} label="Copy link" />
            <a
              className="button button-small"
              href={`/api/links/${state.created.id}/qr?format=png&size=1024&download=1`}
            >
              QR code
            </a>
            <a className="button button-small" href={`/links/${state.created.id}`}>
              Open its report
            </a>
          </div>
        </div>
      )}
    </section>
  );
}
