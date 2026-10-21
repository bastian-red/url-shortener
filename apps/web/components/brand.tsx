import Link from 'next/link';

/** The wordmark: a short arrow leaving a pill, which is what a short link does. */
export function Brand({ href = '/' }: { readonly href?: string }) {
  return (
    <Link className="brand" href={href}>
      <svg className="brand-mark" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
        <path
          d="M3 11 11 3M5.5 3H11v5.5"
          stroke="currentColor"
          strokeWidth="1.8"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      url-shortener
    </Link>
  );
}
