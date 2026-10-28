import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';

import './globals.css';

/**
 * The document, the three typefaces, and the skip link.
 *
 * **`auth()` is not called here, and must not be.** A root layout that awaits
 * the session opts every route into dynamic rendering. Pages read it themselves
 * (`lib/session.ts`).
 *
 * The faces come from the airline route map this identity is drawn from
 * (docs/DESIGN.md):
 *
 * - **Jost** for headings and the big figures: a geometric sans in the line of
 *   the faces printed on mid-century timetables and route maps, round enough
 *   that a click count reads as a fare-table figure, not a headline.
 * - **Overpass** for every piece of chrome: derived from Highway Gothic, the
 *   US road-sign face, which was drawn to be read at a glance and at a
 *   distance. That is what a ledger scanned for "which link moved" needs.
 * - **Overpass Mono** for what must read as typed exactly: slugs, URLs, counts
 *   in columns. Short links are case-sensitive, and its `l`, `I` and `1` cannot
 *   be confused.
 *
 * **Self-hosted, not fetched from Google at build time**, for the reason
 * project010 found: Turbopack's Google-font resolver failed intermittently on
 * CI, and a build that depends on a third-party fetch is not reproducible. The
 * three variable woff2 files (latin subset) live in `app/fonts/<Face>/` beside
 * their SIL Open Font License. `lib/identity.test.ts` and
 * `web/scripts/identity-distinct.mjs` read the face names from those paths.
 */
const display = localFont({
  src: [{ path: './fonts/Jost/Jost-latin-wght.woff2', weight: '100 900', style: 'normal' }],
  display: 'swap',
  variable: '--font-display',
});

const ui = localFont({
  src: [{ path: './fonts/Overpass/Overpass-latin-wght.woff2', weight: '100 900', style: 'normal' }],
  display: 'swap',
  variable: '--font-ui',
});

const mono = localFont({
  src: [
    { path: './fonts/Overpass_Mono/OverpassMono-latin-wght.woff2', weight: '300 700', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: { default: 'url-shortener', template: '%s | url-shortener' },
  description:
    'Shorten a link, share it, and watch every click arrive: country, device and referrer, live.',
  robots: { index: false },
};

/** The browser chrome matches the canvas in each scheme (`--bg` in globals.css; identity.test.ts pins both). */
export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#dce8f7' },
    { media: '(prefers-color-scheme: dark)', color: '#0b1a35' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${ui.variable} ${mono.variable}`}>
      <body>
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
