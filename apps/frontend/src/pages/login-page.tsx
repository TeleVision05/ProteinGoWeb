import { useEffect, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useSession } from '@/components/session';
import { authClient } from '@/lib/auth-client';

export function LoginPage() {
  const { state, me } = useSession();
  const [params] = useSearchParams();
  const [googleReady, setGoogleReady] = useState(true);
  const [pending, setPending] = useState(false);
  const failed = params.has('error');

  useEffect(() => {
    fetch('/api/health')
      .then((response) => response.json())
      .then((body: { google?: boolean }) => setGoogleReady(Boolean(body.google)))
      .catch(() => setGoogleReady(false));
  }, []);

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
                callbackURL: window.location.origin + '/',
                errorCallbackURL: window.location.origin + '/login',
              });
            }}
          >
            Continue with Google
          </Button>
        </div>
      </section>
    </main>
  );
}
