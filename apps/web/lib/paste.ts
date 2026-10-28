/**
 * Whether text pasted outside a field is worth shortening (the command bar's
 * paste-anywhere). Deliberately narrower than what the API accepts: a stray
 * paste of a sentence must never become a link, so this wants an http(s) URL,
 * or a bare host with a dot and no whitespace (the API assumes https for those).
 * The API stays the authority on what is valid; this only decides whether to try.
 */
export function looksLikeUrl(text: string): boolean {
  if (text.length === 0 || text.length > 2048 || /\s/u.test(text)) return false;
  if (/^https?:\/\//iu.test(text)) return URL.canParse(text);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/iu.test(text);
}
