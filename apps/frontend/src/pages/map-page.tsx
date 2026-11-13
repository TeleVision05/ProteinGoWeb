import { apiOrigin } from '@/lib/config';
import { useAr } from '@/components/ar-provider';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CampusMap } from '@/components/campus-map';
import { useSession } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api';
import { signOutEverywhere } from '@/lib/auth-client';
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
  const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN;
  const ar = useAr();
  const arActive = ar.status === 'ar' || ar.status === 'preview';

  useEffect(() => {
    if (arActive) return;
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
  }, [arActive]);

  useEffect(() => {
    if (arActive) return;
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
  }, [arActive]);

  const selected = spawns.find((spawn) => spawn.id === selectedId) ?? null;
  const distance = useMemo(() => {
    if (!selected || !here) return null;
    return distanceMeters(here.lat, here.lng, selected.latitude, selected.longitude);
  }, [selected, here]);
  const inRange = distance != null && selected != null && distance <= selected.radiusMeters + 25;

  // Start downloading the model as soon as a protein is selected, so Catch / View Model can open AR instantly.
  const { prepare } = ar;
  useEffect(() => {
    if (selected?.hasModel) prepare(selected);
  }, [selected, prepare]);

  const modelReady = selected != null && ar.preparedId === selected.id && ar.status !== 'loading' && ar.status !== 'idle';
  const modelLoading = selected != null && ar.preparedId === selected.id && ar.status === 'loading';
  const loadingLabel = ar.progress >= 0 ? `Loading model ${Math.round(ar.progress * 100)}%` : 'Loading model…';

  // Catching opens the AR view. Browsers only start AR right after a tap, so it opens immediately and the
  // catch result follows: if the server turns the catch down, AR closes again and the reason is shown.
  function catchSelected() {
    if (!selected || !here) return;
    const spawn = selected;
    const opensAr = spawn.hasModel && modelReady;
    setPending(true);
    setActionError('');
    const request = api(`/api/spawns/${spawn.id}/catch`, {
      method: 'POST',
      body: JSON.stringify({ latitude: here.lat, longitude: here.lng }),
    });
    if (opensAr) ar.enter();
    request
      .then(() => {
        setSpawns((current) => current.map((item) => (item.id === spawn.id ? { ...item, caught: true } : item)));
      })
      .catch((error: unknown) => {
        if (opensAr) ar.exit();
        setActionError(error instanceof ApiError ? error.message : 'Catch failed.');
      })
      .finally(() => setPending(false));
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
            onClick={() => void signOutEverywhere()}
          >
            Sign out
          </Button>
        </div>
      </header>
      <div className="relative min-h-0 flex-1 bg-background">
        {/* The map stays mounted (rebuilding it after AR froze phones); it is idle while AR runs. */}
        {mapboxToken ? (
          <CampusMap
            token={mapboxToken}
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
              Add VITE_MAPBOX_TOKEN to show the campus map. Spawns are listed here until then.
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
              {!selected.hasModel ? (
                <p className="text-xs text-muted-foreground">No model attached. Add one in /admin.</p>
              ) : null}
              {ar.error ? <p className="text-sm text-destructive">{ar.error}</p> : null}
              {actionError ? <p className="text-sm text-destructive">{actionError}</p> : null}
              <div className="flex gap-2">
                {selected.caught ? (
                  <Button disabled={!selected.hasModel || !modelReady} onClick={() => ar.enter()}>
                    {modelLoading ? loadingLabel : 'View Model'}
                  </Button>
                ) : (
                  <Button disabled={pending || !inRange || modelLoading} onClick={catchSelected}>
                    {modelLoading ? loadingLabel : 'Catch'}
                  </Button>
                )}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
