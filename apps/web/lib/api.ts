import 'server-only';

/**
 * The server-side client for the API.
 *
 * **The browser never calls `apps/api`.** Server components read through
 * `apiFetch` and server actions write through it. One origin for the browser
 * means no CORS surface on the API and no service token in browser JavaScript.
 *
 * **A fresh token per call, never one cached in module scope.** Service tokens
 * live 120 seconds. A module-level token in a long-lived Node process is valid
 * for two minutes after a deploy and rejected for the rest of the day, which is
 * the hardest shape of bug to reproduce. Minting is one HMAC; it is not worth
 * caching.
 *
 * `import 'server-only'` is the enforcement: a client component that imported
 * this for its types would pull `jsonwebtoken` and `AUTH_SECRET` into the browser
 * bundle, and the build fails instead.
 *
 * Every response is parsed with its `@links/shared` schema. A page renders
 * whatever it is handed, so an API that drifted would produce a blank region
 * rather than an error, and the failure would be blamed on CSS.
 *
 * **Anonymous calls carry the browser's address.** The API rate-limits sign-in
 * and sign-up per address, and every request it sees comes from this server;
 * without `x-forwarded-for` everybody in the world would share one budget.
 * Signed-in calls are limited per user and need nothing extra.
 */
import type { SessionUser } from '@links/shared';
import { mintServiceToken } from '@links/shared/server';
import type { z } from 'zod';

import { headers } from 'next/headers';

import { apiBaseUrl, authSecret } from './config';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Structured `details` from the API: which field was refused, and why. */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
}

/**
 * The browser's address as this server received it: the first entry of an
 * incoming `x-forwarded-for` (a proxy in front of Next), else `x-real-ip`.
 * Null when neither exists, which is local development, where the API then sees
 * this server's address -- correct, since there is only one browser.
 */
async function clientAddress(): Promise<string | null> {
  try {
    const incoming = await headers();
    const forwarded = incoming.get('x-forwarded-for')?.split(',')[0]?.trim();
    return forwarded || incoming.get('x-real-ip') || null;
  } catch {
    // Outside a request (a build-time render): no browser, no address.
    return null;
  }
}

async function call<T>(
  baseUrl: string,
  user: SessionUser | null,
  path: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  options: RequestOptions,
): Promise<T> {
  const address = user === null ? await clientAddress() : null;
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      // `null` for the public routes (auth, status): there is no session,
      // so there is nobody to mint a token for, and the address is forwarded.
      ...(user === null ? {} : { authorization: `Bearer ${mintServiceToken(user, authSecret())}` }),
      ...(address === null ? {} : { 'x-forwarded-for': address }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    // Every route here is per-session and changes as people type. Next's data
    // cache holding one is a ledger showing a click count from an hour ago.
    cache: 'no-store',
  });

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text === '' ? null : JSON.parse(text);
  } catch {
    // A non-JSON body means a proxy or an error page answered instead of the app.
    // Reported below with the status, which is the only useful thing left.
  }

  if (!response.ok) {
    const problem = payload as { code?: unknown; message?: unknown; details?: unknown } | null;
    throw new ApiError(
      response.status,
      typeof problem?.code === 'string' ? problem.code : 'INTERNAL',
      typeof problem?.message === 'string'
        ? problem.message
        : `The server answered ${String(response.status)}.`,
      problem?.details,
    );
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    // Issues go to the server log, never to the page: they quote the payload back,
    // and the payload can carry a destination URL with a token in it.
    console.error(`[web] ${path} did not match its contract`, parsed.error.issues);
    throw new ApiError(
      500,
      'INTERNAL',
      'The server returned something this app does not understand.',
    );
  }
  return parsed.data;
}

/**
 * One call to `apps/api`, parsed. The schema is a parameter, not a generic with a
 * cast, so there is no overload that returns unparsed JSON.
 */
export function apiFetch<T>(
  user: SessionUser | null,
  path: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  options: RequestOptions = {},
): Promise<T> {
  return call(apiBaseUrl, user, path, schema, options);
}

/**
 * A raw response from the API, passed through to the browser untouched rather
 * than parsed: a QR image, or the live feed's event stream. Signed-in only.
 * `signal` lets a route handler cancel the upstream request when the browser
 * goes away, so a closed tab does not leave a stream open on the API.
 */
export async function apiStream(
  user: SessionUser,
  path: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${apiBaseUrl}${path}`, {
    headers: { authorization: `Bearer ${mintServiceToken(user, authSecret())}` },
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  });
}

/** A query string from the defined entries only, so `undefined` never becomes the text "undefined". */
export function query(params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}
