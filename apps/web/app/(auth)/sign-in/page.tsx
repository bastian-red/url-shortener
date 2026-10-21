import Link from 'next/link';

import { AuthForm } from '../../../components/auth-form';
import { Brand } from '../../../components/brand';
import { safeNextPath } from '../../../lib/next-path';
import { signInAction } from '../actions';

export const metadata = { title: 'Sign in' };

/**
 * Sign in. `next` is where a deep link was going; it is validated
 * here and again in the action, so a crafted value can only ever land on `/`.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNextPath((await searchParams).next);
  return (
    <main id="main" className="auth-page">
      <div className="auth-card">
        <Brand />
        <h1 className="auth-title">Sign in</h1>
        <AuthForm mode="sign-in" next={next} action={signInAction} />
        <p className="auth-demo">
          Demo account: <code>demo@links.test</code> / <code>demo-password-2026</code>
        </p>
        <p className="auth-switch">
          No account yet? <Link href={`/sign-up?next=${encodeURIComponent(next)}`}>Create one</Link>
        </p>
      </div>
    </main>
  );
}
