import Link from 'next/link';

import { Brand } from '../components/brand';

export default function NotFound() {
  return (
    <main id="main" className="auth-page">
      <div className="auth-card">
        <Brand />
        <h1 className="auth-title">Nothing here</h1>
        <p style={{ margin: 0, color: 'var(--muted)' }}>
          That page does not exist, or the link belongs to another account.
        </p>
        <Link className="button" href="/">
          Back to your links
        </Link>
      </div>
    </main>
  );
}
