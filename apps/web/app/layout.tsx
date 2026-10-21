import type { Metadata, Viewport } from 'next';
import { Bricolage_Grotesque, Martian_Mono, Schibsted_Grotesk } from 'next/font/google';
import type { ReactNode } from 'react';

import './globals.css';

/**
 * The document, the three typefaces, and the skip link.
 *
 * **`auth()` is not called here, and must not be.** A root layout that awaits
 * the session opts every route into dynamic rendering. Pages read it themselves
 * (`lib/session.ts`).
 *
 * The faces:
 *
 * - **Bricolage Grotesque** for headings and the big numbers: a grotesque with
 *   some ink-trap character, so a click count at 30px reads as a figure on an
 *   instrument, not a heading.
 * - **Schibsted Grotesk** for every piece of chrome: a newsroom sans built for
 *   dense, scannable interfaces.
 * - **Martian Mono** for what must read as typed exactly: slugs, URLs, counts in
 *   columns. Short links are case-sensitive, and a mono face makes `l`, `I` and
 *   `1` impossible to confuse.
 *
 * No serif, deliberately: this is an instrument, not a page to read.
 *
 * ONE import statement, single-quoted, on purpose. `lib/identity.test.ts` and
 * `web/scripts/identity-distinct.mjs` parse it with the same regex.
 */
const display = Bricolage_Grotesque({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-display',
  weight: ['500', '600', '700'],
});

const ui = Schibsted_Grotesk({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-ui',
  weight: ['400', '500', '600', '700'],
});

const mono = Martian_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
  weight: ['400', '500', '600'],
});

export const metadata: Metadata = {
  title: { default: 'url-shortener', template: '%s | url-shortener' },
  description:
    'Shorten a link, share it, and watch every click arrive: country, device and referrer, live.',
  robots: { index: false },
};

export const viewport: Viewport = {
  colorScheme: 'light dark',
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
