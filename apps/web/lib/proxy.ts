import 'server-only';

import { auth } from '../auth';
import { apiStream } from './api';

/**
 * The few browser-initiated requests (the live feed, a QR image, a re-scoped
 * report) come here, to this app's own origin, and are forwarded to the API
 * with a service token minted from the session. The browser never holds a
 * token and the API never needs CORS.
 */

const ID = /^[a-z0-9]{20,40}$/u;

export function validId(id: string): boolean {
  return ID.test(id);
}

/** Forward a GET, streaming the body through untouched. 401 without a session. */
export async function forward(
  request: Request,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const session = await auth();
  if (!session?.user)
    return Response.json({ code: 'UNAUTHENTICATED', message: 'Sign in first.' }, { status: 401 });

  let upstream: Response;
  try {
    upstream = await apiStream(session.user, path, request.signal);
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    console.error(`[web] ${path} could not reach the API:`, error);
    return Response.json(
      { code: 'INTERNAL', message: 'The API is not answering.' },
      { status: 502 },
    );
  }

  const headers = new Headers(extraHeaders);
  for (const name of ['content-type', 'cache-control', 'content-disposition']) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

/** SSE needs one more promise: no buffering anywhere between the API and the tab. */
export const SSE_HEADERS = { 'x-accel-buffering': 'no', 'cache-control': 'no-cache, no-transform' };
