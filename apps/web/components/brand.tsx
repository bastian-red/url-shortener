import Link from 'next/link';

/** The wordmark: two airports and the route arc between them, which is what a short link is. */
export function Brand({ href = '/' }: { readonly href?: string }) {
  return (
    <Link className="brand" href={href}>
      <svg className="brand-mark" viewBox="0 0 30 20" aria-hidden="true" focusable="false">
        <path
          className="brand-route"
          d="M5 15C9 4 21 4 25 15"
          strokeWidth="2.6"
          fill="none"
          strokeLinecap="round"
          strokeDasharray="0.1 3.6"
        />
        <circle cx="5" cy="15" r="3" fill="currentColor" />
        <circle cx="25" cy="15" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
      url-shortener
    </Link>
  );
}
