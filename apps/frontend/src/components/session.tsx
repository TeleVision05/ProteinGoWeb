import { API_URL } from '@/lib/config';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';

type SessionValue = {
  me: Me | null;
  state: 'loading' | 'anon' | 'ready';
  refresh: () => Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<SessionValue['state']>('loading');

  const refresh = useCallback(async () => {
    const response = await fetch(`${API_URL}/api/me`, { credentials: 'include' });
    if (response.status === 401) {
      setMe(null);
      setState('anon');
      return;
    }
    if (!response.ok) throw new Error('Could not load your session');
    setMe((await response.json()) as Me);
    setState('ready');
  }, []);

  useEffect(() => {
    refresh().catch(() => setState('anon'));
  }, [refresh]);

  return <SessionContext.Provider value={{ me, state, refresh }}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('SessionProvider is missing');
  return value;
}

export function RequireUser({ children }: { children: ReactNode }) {
  const { state } = useSession();
  if (state === 'loading') return <ScreenNote>Checking your UCR sign-in…</ScreenNote>;
  if (state === 'anon') return <Navigate to="/login" replace />;
  return children;
}

export function RequirePlay({ children }: { children: ReactNode }) {
  const { state, me } = useSession();
  if (state === 'loading') return <ScreenNote>Checking your UCR sign-in…</ScreenNote>;
  if (state === 'anon' || !me) return <Navigate to="/login" replace />;
  if (!me.access.active && !me.isAdmin) return <Navigate to="/redeem" replace />;
  return children;
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { state, me } = useSession();
  if (state === 'loading') return <ScreenNote>Checking your UCR sign-in…</ScreenNote>;
  if (state === 'anon' || !me) return <Navigate to="/login" replace />;
  if (!me.isAdmin) return <Navigate to="/" replace />;
  return children;
}

function ScreenNote({ children }: { children: ReactNode }) {
  return <div className="grid min-h-dvh place-items-center px-6 text-sm text-muted-foreground">{children}</div>;
}

export async function redeem(code: string) {
  return api<Me['access']>('/api/codes/redeem', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}
