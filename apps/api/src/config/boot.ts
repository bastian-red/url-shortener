/**
 * What must be true before `NestFactory.create` is called.
 *
 * **Every reason this process will not work is discovered before it is
 * listening.** An API that binds :4000 and then fails on the first save looks
 * healthy to a container runtime, gets traffic, and produces a user-facing error
 * for an operational fact that was already true when the process started.
 *
 * Called from `main.ts` before the Nest application exists, so a failure here is
 * a plain sentence on stderr rather than a framework stack with the one useful
 * line buried in the middle of it.
 */
import type { ApiConfig } from './config';

export class BootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootError';
  }
}

/**
 * The JSON body ceiling `main.ts` gives express. The largest body this API
 * accepts is a link with a 2,048-character URL; 64 KB is that with room.
 */
export const JSON_BODY_LIMIT_BYTES = 65_536;

export function assertConsistent(config: ApiConfig): void {
  // Auth is the credential-stuffing surface, so its budget is deliberately far
  // below the general one. A configuration where auth is the looser of the two
  // is almost certainly a copy-paste, and it is the exact mistake that turns a
  // rate limit into decoration.
  if (config.rateLimitAuth >= config.rateLimitGlobal) {
    throw new BootError(
      `RATE_LIMIT_AUTH (${String(config.rateLimitAuth)}) must be below RATE_LIMIT_GLOBAL ` +
        `(${String(config.rateLimitGlobal)}). Auth is the credential-stuffing surface; a budget ` +
        'at or above the general one is not a limit.',
    );
  }

  // Link creation is the spam surface: a stolen session pointed at a phishing
  // kit creates links, it does not read dashboards.
  if (config.rateLimitCreate >= config.rateLimitGlobal) {
    throw new BootError(
      `RATE_LIMIT_CREATE (${String(config.rateLimitCreate)}) must be below RATE_LIMIT_GLOBAL ` +
        `(${String(config.rateLimitGlobal)}).`,
    );
  }

  // A short link on the app's own origin would be answered by Next.js, not by
  // the redirect service, and every link would 404.
  if (new URL(config.shortBaseUrl).origin === new URL(config.appBaseUrl).origin) {
    throw new BootError(
      'SHORT_BASE_URL and APP_BASE_URL are the same origin. Short links are served by the ' +
        'redirect service, which needs its own origin (a port locally, a domain in production).',
    );
  }
}

export function assertBootable(config: ApiConfig): void {
  assertConsistent(config);
}
