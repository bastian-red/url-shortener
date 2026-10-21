'use server';

import { linkSchema, type Link } from '@links/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { signOut } from '../../auth';
import { ApiError, apiFetch } from '../../lib/api';
import { localToIso } from '../../lib/datetime';
import { requireUser } from '../../lib/session';

/**
 * Link writes, as server actions: the form posts here, this calls the API with
 * a service token, and the page re-renders. No browser JavaScript touches the
 * API and every form works before hydration.
 */

export interface CreateState {
  readonly error: string | null;
  readonly field: string | null;
  readonly created: Link | null;
}

export interface EditState {
  readonly error: string | null;
  readonly field: string | null;
  readonly saved: boolean;
}

/** The API's own sentence for a refusal it explained; a fixed one for anything else. */
function explain(error: unknown): { error: string; field: string | null } {
  if (error instanceof ApiError) {
    const field = (error.details as { field?: unknown } | undefined)?.field;
    if (error.status === 429)
      return {
        error: 'You are creating links very quickly. Wait a minute and try again.',
        field: null,
      };
    if (error.status < 500)
      return { error: error.message, field: typeof field === 'string' ? field : null };
  }
  console.error('[web] link write failed:', error);
  return { error: 'That could not be saved. Try again in a moment.', field: null };
}

const optionalText = (value: FormDataEntryValue | null): string | undefined => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? undefined : text;
};

export async function createLinkAction(
  _previous: CreateState,
  form: FormData,
): Promise<CreateState> {
  const user = await requireUser('/');
  const offset = Number(form.get('tzOffset') ?? 0) || 0;
  const expires = optionalText(form.get('expiresAt'));
  const max = optionalText(form.get('maxClicks'));
  const body = {
    url: String(form.get('url') ?? ''),
    slug: optionalText(form.get('slug')),
    title: optionalText(form.get('title')),
    expiresAt: expires === undefined ? undefined : localToIso(expires, offset),
    maxClicks: max === undefined ? undefined : Number(max),
  };
  if (body.url.trim() === '')
    return { error: 'Paste a URL to shorten.', field: 'url', created: null };
  if (body.maxClicks !== undefined && (!Number.isInteger(body.maxClicks) || body.maxClicks < 1)) {
    return {
      error: 'A click limit is a whole number of at least 1.',
      field: 'maxClicks',
      created: null,
    };
  }
  try {
    const created = await apiFetch(user, '/links', linkSchema, { method: 'POST', body });
    revalidatePath('/');
    return { error: null, field: null, created };
  } catch (error) {
    return { ...explain(error), created: null };
  }
}

const idSchema = z
  .string()
  .min(20)
  .max(40)
  .regex(/^[a-z0-9]+$/u);

export async function updateLinkAction(_previous: EditState, form: FormData): Promise<EditState> {
  const id = idSchema.parse(form.get('id'));
  const user = await requireUser(`/links/${id}`);
  const offset = Number(form.get('tzOffset') ?? 0) || 0;
  const expires = String(form.get('expiresAt') ?? '').trim();
  const max = String(form.get('maxClicks') ?? '').trim();
  const body = {
    url: String(form.get('url') ?? '').trim(),
    title: String(form.get('title') ?? '').trim() || null,
    // Blank means "no expiry" / "no limit": the edit form shows every field, so
    // an empty one is a deliberate clear, not an omission.
    expiresAt: expires === '' ? null : localToIso(expires, offset),
    maxClicks: max === '' ? null : Number(max),
  };
  if (body.maxClicks !== null && (!Number.isInteger(body.maxClicks) || body.maxClicks < 1)) {
    return {
      error: 'A click limit is a whole number of at least 1, or blank for none.',
      field: 'maxClicks',
      saved: false,
    };
  }
  try {
    await apiFetch(user, `/links/${id}`, linkSchema, { method: 'PATCH', body });
    revalidatePath(`/links/${id}`);
    revalidatePath('/');
    return { error: null, field: null, saved: true };
  } catch (error) {
    return { ...explain(error), saved: false };
  }
}

export async function setDisabledAction(form: FormData): Promise<void> {
  const id = idSchema.parse(form.get('id'));
  const user = await requireUser(`/links/${id}`);
  await apiFetch(user, `/links/${id}`, linkSchema, {
    method: 'PATCH',
    body: { disabled: form.get('disabled') === 'true' },
  });
  revalidatePath(`/links/${id}`);
  revalidatePath('/');
}

export async function deleteLinkAction(form: FormData): Promise<void> {
  const id = idSchema.parse(form.get('id'));
  const user = await requireUser(`/links/${id}`);
  await apiFetch(user, `/links/${id}`, z.unknown(), { method: 'DELETE' });
  revalidatePath('/');
  redirect('/?deleted=1');
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: '/sign-in' });
}
