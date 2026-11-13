import { API_URL } from '@/lib/config';
import { useEffect, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useSession } from '@/components/session';
import { api, ApiError } from '@/lib/api';
import { authClient } from '@/lib/auth-client';

type DevAccount = { role: 'admin' | 'student'; email: string; name: string; isAdmin: boolean };

export function LoginPage() {
  const { state, me, refresh } = useSession();
  const [params] = useSearchParams();
  const [googleReady, setGoogleReady] = useState(true);
  const [pending, setPending] = useState(false);
  const [devAccounts, setDevAccounts] = useState<DevAccount[]>([]);
  const [devError, setDevError] = useState('');
  const failed = params.has('error');

  useEffect(() => {
    fetch(`${API_URL}/api/health`)
      .then((response) => response.json())
      .then((body: { google?: boolean; devAccounts?: DevAccount[] }) => {
        setGoogleReady(Boolean(body.google));
        setDevAccounts(body.devAccounts ?? []);
      })
      .catch(() => setGoogleReady(false));
  }, []);

  async function devSignIn(role: DevAccount['role']) {
    setPending(true);
    setDevError('');
    try {
      await api('/api/dev/login', { method: 'POST', body: JSON.stringify({ role }) });
      await refresh();
    } catch (caught) {
      setDevError(caught instanceof ApiError ? caught.message : 'Could not sign in.');
      setPending(false);
    }
  }

  if (state === 'ready' && me) {
    return <Navigate to={me.access.active || me.isAdmin ? '/' : '/redeem'} replace />;
  }

  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.1fr_0.9fr]">
      <section className="flex flex-col justify-between bg-campus px-8 py-10 text-primary-foreground lg:px-14">
        <p className="text-xs font-semibold tracking-[0.22em] uppercase text-gold">University of California, Riverside</p>
        <div className="max-w-md py-16">
          <h1 className="font-display text-5xl leading-none font-semibold">ProteinGo</h1>
          <p className="mt-5 text-lg text-primary-foreground/80">
            Walk campus, find a protein where it was placed, and catch it when you are close enough to see it in AR.
          </p>
        </div>
        <p className="text-sm text-primary-foreground/60">Google sign-in is limited to ucr.edu accounts.</p>
      </section>
      <section className="grid place-items-center px-6 py-16">
        <div className="w-full max-w-sm">
          <h2 className="font-display text-3xl">Sign in</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            A class code still has to be entered after sign-in. There is no password.
          </p>
          {failed ? (
            <p className="mt-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              Sign-in stopped. Use the Google account for your ucr.edu address.
            </p>
          ) : null}
          {!googleReady ? (
            <p className="mt-4 text-sm text-muted-foreground">
              Google OAuth is not configured on the server yet. Add the client id and secret, then reload.
            </p>
          ) : null}
          <Button
            className="mt-6 w-full"
            size="lg"
            disabled={pending || state === 'loading' || !googleReady}
            onClick={() => {
              setPending(true);
              void authClient.signIn.social({
                provider: 'google',
                callbackURL: window.location.origin + import.meta.env.BASE_URL,
                errorCallbackURL: window.location.origin + import.meta.env.BASE_URL + 'login',
              });
            }}
          >
            Continue with Google
          </Button>
          {devAccounts.length ? (
            <div className="mt-8 rounded-lg border border-dashed p-4">
              <p className="text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                Local dev sign-in
              </p>
              <p className="mt-1 text-xs text-muted-foreground">Skips Google. Only shown while the dev bypass is on.</p>
              <div className="mt-3 grid gap-2">
                {devAccounts.map((account) => (
                  <Button
                    key={account.role}
                    variant="outline"
                    className="h-auto justify-between py-2 text-left"
                    disabled={pending}
                    onClick={() => void devSignIn(account.role)}
                  >
                    <span>
                      <span className="block font-medium">{account.isAdmin ? 'Dev admin' : 'Dev student'}</span>
                      <span className="block text-xs font-normal text-muted-foreground">{account.email}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {account.isAdmin ? 'Can open /admin' : 'Needs a class code'}
                    </span>
                  </Button>
                ))}
              </div>
              {devError ? <p className="mt-2 text-sm text-destructive">{devError}</p> : null}
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
