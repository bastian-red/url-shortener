'use client';

import { useActionState, useEffect, useRef } from 'react';

import type { CreateState } from '../app/(app)/actions';
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
  const offset = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (offset.current) offset.current.value = String(new Date().getTimezoneOffset());
  }, []);

  useEffect(() => {
    if (state.created) form.current?.reset();
  }, [state.created]);

  const invalid = (field: string) => (state.field === field ? true : undefined);

  return (
    <section className="command" aria-labelledby="command-title">
      <h1 id="command-title" className="command-title">
        Shorten a link
      </h1>
      <form ref={form} action={formAction} className="command-form" noValidate>
        <input ref={offset} type="hidden" name="tzOffset" defaultValue="0" />
        <div className="command-row">
          <label className="visually-hidden" htmlFor="url">
            Destination URL
          </label>
          <input
            id="url"
            name="url"
            className="field-input command-input"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste a long URL, e.g. https://example.com/a/very/long/path"
            required
            autoFocus
            aria-invalid={invalid('url')}
            aria-describedby={state.error ? 'command-error' : undefined}
          />
          <button className="button button-primary" type="submit" disabled={pending}>
            {pending ? 'Shortening' : 'Shorten'}
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
        <div className="created" role="status">
          <span className="created-label">Short link ready</span>
          <a className="slug-pill" href={`/links/${state.created.id}`}>
            {state.created.slug}
          </a>
          <code className="mono" data-testid="created-short-url">
            {state.created.shortUrl}
          </code>
          <CopyButton value={state.created.shortUrl} label="Copy link" />
          <a
            className="button button-small"
            href={`/api/links/${state.created.id}/qr?format=png&size=1024&download=1`}
          >
            QR code
          </a>
        </div>
      )}
    </section>
  );
}
