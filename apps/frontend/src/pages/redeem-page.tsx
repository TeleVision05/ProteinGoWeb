import { FormEvent, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { redeem, useSession } from '@/components/session';
import { ApiError } from '@/lib/api';
import { authClient } from '@/lib/auth-client';

export function RedeemPage() {
  const { me, refresh } = useSession();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  if (me?.access.active) return <Navigate to="/" replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      await redeem(code);
      await refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not redeem that code.');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Class code</CardTitle>
          <CardDescription>
            {me?.user.email} is signed in. Play stays open until the code your section used expires.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="code">Code</Label>
              <Input
                id="code"
                autoComplete="off"
                autoCapitalize="characters"
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                placeholder="LAB-4F2K"
              />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" disabled={pending || code.trim().length < 4}>
              Unlock the map
            </Button>
          </form>
          <div className="mt-4 flex items-center justify-between text-sm">
            {me?.isAdmin ? (
              <Link className="underline" to="/admin">
                Admin
              </Link>
            ) : (
              <span />
            )}
            <button
              className="text-muted-foreground underline"
              onClick={() => void authClient.signOut().then(() => window.location.assign('/login'))}
            >
              Sign out
            </button>
          </div>
          {me?.access.label ? (
            <p className="mt-3 text-xs text-muted-foreground">{me.access.label} is no longer active.</p>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
