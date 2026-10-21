import { MAX_URL_LENGTH } from '@links/shared';

/**
 * Destination URL rules.
 *
 * The shortener never fetches a destination, so this is not SSRF defence; it is
 * about what a redirect may point at:
 *
 * - **http and https only.** `javascript:` and `data:` in a `Location` header
 *   are refused by modern browsers anyway, but storing one is a stored-XSS
 *   waiting for any surface that renders the destination as a link.
 * - **No credentials.** `https://paypal.com@evil.example` displays as PayPal and
 *   goes to evil.example. A shortener is exactly the tool that hides that, so it
 *   refuses to.
 * - **Not the short domain itself.** A link to another short link on this
 *   service makes redirect chains, and a link to itself makes a loop the
 *   browser gives up on after 20 hops, each one a counted click.
 *
 * The URL is normalised by WHATWG `URL`: the host is lowercased and IDNs become
 * punycode, so `https://ÉXAMPLE.com` and `https://xn--xample-9ua.com` are the
 * same destination and the loop check cannot be dodged with case or Unicode.
 */

export type DestinationIssue =
  'unparseable' | 'scheme' | 'credentials' | 'no_host' | 'self_reference' | 'too_long';

export type DestinationResult =
  { ok: true; url: string } | { ok: false; issue: DestinationIssue; message: string };

const MESSAGES: Record<DestinationIssue, string> = {
  unparseable: 'That is not a URL. Include the scheme, like https://',
  scheme: 'Only http:// and https:// links can be shortened.',
  credentials:
    'Links with a user name or password in them are refused: they disguise where they go.',
  no_host: 'The URL has no host.',
  self_reference:
    'That URL is already a short link on this service; link to its destination instead.',
  too_long: `URLs longer than ${MAX_URL_LENGTH} characters are refused.`,
};

const fail = (issue: DestinationIssue): DestinationResult => ({
  ok: false,
  issue,
  message: MESSAGES[issue],
});

/**
 * @param shortHosts hosts this service answers on (the short domain, and the
 *   app's own host), compared after normalisation, port included.
 */
export function checkDestination(raw: string, shortHosts: readonly string[]): DestinationResult {
  const input = raw.trim();
  // A bare `example.com/page` is what people paste; assume https rather than
  // refusing, but only when there is no scheme at all.
  const candidate = /^[a-z][a-z0-9+.-]*:/iu.test(input) ? input : `https://${input}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return fail('unparseable');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail('scheme');
  if (url.username !== '' || url.password !== '') return fail('credentials');
  if (url.hostname === '') return fail('no_host');

  const normalisedShortHosts = shortHosts.map((host) => new URL(`http://${host}`).host);
  if (normalisedShortHosts.includes(url.host)) return fail('self_reference');

  const href = url.href;
  if (href.length > MAX_URL_LENGTH) return fail('too_long');
  return { ok: true, url: href };
}

/** The `host` (with port) of an absolute URL, for building `shortHosts`. */
export function hostOf(absoluteUrl: string): string {
  return new URL(absoluteUrl).host;
}
