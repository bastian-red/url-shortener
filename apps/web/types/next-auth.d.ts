/**
 * The session shape, taught to Auth.js.
 *
 * Auth.js types `session.user` as `{ name?, email?, image? }`, which has none of
 * what this app needs: the id every link query is scoped by. `SessionUser` is the
 * contract from `@links/shared`, so this cannot drift from what `auth.ts` parses
 * into the token.
 */
import type { SessionUser } from '@links/shared';

declare module 'next-auth' {
  interface Session {
    user: SessionUser;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    /** Namespaced, so it cannot collide with a claim Auth.js owns. */
    links?: SessionUser;
  }
}
