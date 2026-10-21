'use client';

import { useActionState, useEffect, useRef } from 'react';

import type { Link } from '@links/shared';

import type { EditState } from '../app/(app)/actions';
import { isoToLocal } from '../lib/datetime';

interface Props {
  readonly link: Link;
  readonly timeZone: string;
  readonly action: (previous: EditState, form: FormData) => Promise<EditState>;
}

/** Edit everything but the slug (a printed QR code points at it). */
export function EditLink({ link, timeZone, action }: Props) {
  const [state, formAction, pending] = useActionState(action, {
    error: null,
    field: null,
    saved: false,
  });
  const offset = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (offset.current) offset.current.value = String(new Date().getTimezoneOffset());
  }, []);
  const invalid = (field: string) => (state.field === field ? true : undefined);

  return (
    <form action={formAction} className="edit">
      <input type="hidden" name="id" value={link.id} />
      <input ref={offset} type="hidden" name="tzOffset" defaultValue="0" />
      <div className="edit-grid">
        <label className="field" style={{ gridColumn: '1 / -1' }}>
          <span className="field-label">Destination</span>
          <input
            className="field-input mono"
            name="url"
            type="text"
            defaultValue={link.url}
            required
            spellCheck={false}
            aria-invalid={invalid('url')}
          />
          <span className="field-hint">
            Changing it takes effect on the very next visit. Printed QR codes keep working.
          </span>
        </label>
        <label className="field">
          <span className="field-label">Title</span>
          <input
            className="field-input"
            name="title"
            type="text"
            maxLength={120}
            defaultValue={link.title ?? ''}
          />
        </label>
        <label className="field">
          <span className="field-label">Expires</span>
          <input
            className="field-input"
            name="expiresAt"
            type="datetime-local"
            defaultValue={isoToLocal(link.expiresAt, timeZone)}
            aria-invalid={invalid('expiresAt')}
          />
          <span className="field-hint">Blank for never.</span>
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
            defaultValue={link.maxClicks ?? ''}
            placeholder="No limit"
            aria-invalid={invalid('maxClicks')}
          />
          <span className="field-hint">Counts every visit, people and link previews alike.</span>
        </label>
      </div>
      {state.error === null ? null : (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      {state.saved ? (
        <p className="notice" role="status">
          Saved. The redirect already uses it.
        </p>
      ) : null}
      <div className="edit-actions">
        <button className="button button-primary" type="submit" disabled={pending}>
          {pending ? 'Saving' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
