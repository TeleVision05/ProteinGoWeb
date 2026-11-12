import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CampusMap } from '@/components/campus-map';
import { useSession } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import type { Spawn } from '@/lib/types';
import { distanceMeters, formatDistance, formatWhen } from '@/lib/utils';

type Here = { lat: number; lng: number; accuracy: number };

export function MapPage() {
  const { me } = useSession();
  const [spawns, setSpawns] = useState<Spawn[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [here, setHere] = useState<Here | null>(null);
  const [geoError, setGeoError] = useState('');
  const [actionError, setActionError] = useState('');
  const [pending, setPending] = useState(false);
  const mapsKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

  useEffect(() => {
    let stop = false;
    const load = () => {
      api<Spawn[]>('/api/spawns')
        .then((rows) => {
          if (!stop) setSpawns(rows);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 20_000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!navigator.geolocation) {
      setGeoError('This browser cannot share your location.');
      return;
    }
    const watch = navigator.geolocation.watchPosition(
      (position) => {
        setGeoError('');
        setHere({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
      },
      () => setGeoError('Location is off. Catching needs it.'),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 12_000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, []);

  const selected = spawns.find((spawn) => spawn.id === selectedId) ?? null;
  const distance = useMemo(() => {
    if (!selected || !here) return null;
    return distanceMeters(here.lat, here.lng, selected.latitude, selected.longitude);
  }, [selected, here]);
  const inRange = distance != null && selected != null && distance <= selected.radiusMeters + 25;

  function inspect(spawn: Spawn) {
    if (!spawn.modelUrl) return;
    const model = new URL(spawn.modelUrl, window.location.origin).href;
    const next = new URL('/ar/index.html', window.location.origin);
    next.searchParams.set('from', 'map');
    next.searchParams.set('model', model);
    next.searchParams.set('name', spawn.name);
    window.location.assign(next.toString());
  }

  async function catchSelected() {
    if (!selected || !here) return;
    setPending(true);
    setActionError('');
    try {
      await api(`/api/spawns/${selected.id}/catch`, {
        method: 'POST',
        body: JSON.stringify({ latitude: here.lat, longitude: here.lng }),
      });
      setSpawns((current) => current.map((spawn) => (spawn.id === selected.id ? { ...spawn, caught: true } : spawn)));
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : 'Catch failed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex h-dvh flex-col bg-campus">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 px-4 text-primary-foreground">
        <div>
          <p className="font-display text-lg leading-none">ProteinGo</p>
          <p className="text-xs text-primary-foreground/70">
            {me?.access.active && me.access.expiresAt
              ? `${me.access.label ?? 'Code'} until ${formatWhen(me.access.expiresAt)}`
              : me?.user.email}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {me?.isAdmin ? (
            <Button asChild size="sm" variant="secondary">
              <Link to="/admin">Admin</Link>
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="text-primary-foreground hover:bg-white/10"
            onClick={() => void authClient.signOut().then(() => window.location.assign('/login'))}
          >
            Sign out
          </Button>
        </div>
      </header>
      <div className="relative min-h-0 flex-1 bg-background">
        {mapsKey ? (
          <CampusMap
            apiKey={mapsKey}
            className="h-full w-full"
            user={here}
            spawns={spawns}
            selectedId={selectedId}
            followUser
            onSelect={setSelectedId}
          />
        ) : (
          <div className="grid h-full content-start gap-2 overflow-auto p-4">
            <p className="text-sm text-muted-foreground">
              Add VITE_GOOGLE_MAPS_API_KEY to show the campus map. Spawns are listed here until then.
            </p>
            {spawns.map((spawn) => (
              <button
                key={spawn.id}
                className="rounded-lg border bg-card px-3 py-2 text-left"
                onClick={() => setSelectedId(spawn.id)}
              >
                <span className="font-medium">{spawn.name}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {here
                    ? formatDistance(distanceMeters(here.lat, here.lng, spawn.latitude, spawn.longitude))
                    : 'Waiting for GPS'}
                </span>
              </button>
            ))}
          </div>
        )}
        <aside className="absolute inset-x-3 bottom-3 rounded-xl border bg-card p-4 shadow-lg md:inset-x-auto md:top-4 md:right-4 md:bottom-auto md:w-80">
          {!selected ? (
            <div>
              <p className="font-medium">Proteins on campus</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {spawns.length === 0
                  ? 'Nothing is placed right now.'
                  : `${spawns.length} on the map. Gold is still out. Green is one you caught.`}
              </p>
              <p className="mt-3 text-xs text-muted-foreground">
                {geoError || (here ? `GPS ±${Math.round(here.accuracy)} m` : 'Finding you…')}
              </p>
            </div>
          ) : (
            <div className="grid gap-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="font-display text-2xl leading-none">{selected.name}</h2>
                  {selected.summary ? <p className="mt-1 text-sm text-muted-foreground">{selected.summary}</p> : null}
                </div>
                <Badge variant={selected.caught ? 'good' : 'gold'}>{selected.caught ? 'Caught' : 'Wild'}</Badge>
              </div>
              <p className="text-sm">
                {distance == null ? 'Waiting for GPS.' : `${formatDistance(distance)} away · ${selected.radiusMeters} m radius`}
              </p>
              {actionError ? <p className="text-sm text-destructive">{actionError}</p> : null}
              <div className="flex gap-2">
                <Button disabled={pending || selected.caught || !inRange} onClick={() => void catchSelected()}>
                  {selected.caught ? 'Caught' : 'Catch'}
                </Button>
                <Button
                  variant="outline"
                  disabled={!selected.hasModel || (!inRange && !selected.caught)}
                  onClick={() => inspect(selected)}
                >
                  Inspect in AR
                </Button>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
