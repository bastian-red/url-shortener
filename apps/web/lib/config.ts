/**
 * Every environment variable this app reads, in one module.
 *
 * All of them are server-only. There is deliberately no `NEXT_PUBLIC_*` name:
 * the browser never calls the API. Server components read through `apiFetch`,
 * server actions write through it, and the few browser-initiated requests (the
 * live feed, a QR download, a re-scoped report) go to this app's own route
 * handlers, which call the API with a service token. So the API has no CORS
 * surface and no service token ever reaches browser JavaScript.
 *
 * Every read is spelled out literally because `scripts/env-contract.mjs` finds
 * reads by pattern and turbo runs in strict env mode: a name it cannot see is a
 * name that is silently stripped from the process.
 */

/** Where the server reaches the API. A service name inside compose, localhost on a laptop. */
export const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:4000';

/** Reported on `/status`, so two builds are tellable apart. */
export const appVersion = process.env.APP_VERSION ?? '0.0.0';

/**
 * The shared HS256 secret.
 *
 * Asserted here rather than where it is used: a missing secret makes every
 * signed-in call fail at once, which presents as an empty ledger rather than an
 * error. Failing here turns that into one sentence.
 */
export function authSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (secret === undefined || secret.length < 16) {
    throw new Error(
      'AUTH_SECRET must be set and at least 16 characters. Without it the web app cannot mint ' +
        'the service token the API verifies.',
    );
  }
  return secret;
}

/**
 * The redirect service's public origin, shown as the prefix of a custom slug.
 * The API builds every short URL itself; this is display only.
 */
export const shortOrigin = process.env.SHORT_BASE_URL ?? 'http://localhost:8080';
