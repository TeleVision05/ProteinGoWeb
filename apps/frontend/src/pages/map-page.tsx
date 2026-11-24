import { useAr } from '@/components/ar-provider';
import type { ChallengeOutcome } from '@/ar/viewer';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HeaderNav, type NavItem } from '@/components/header-nav';
import { CampusMap } from '@/components/campus-map';
import { ExploredStore, type ExploredInfo } from '@/lib/explored';
import { useSession } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { XpBar } from '@/components/xp-bar';
import { api, ApiError } from '@/lib/api';
import { signOutEverywhere } from '@/lib/auth-client';
import type { CatchResult, Progress, Spawn } from '@/lib/types';
import {
  bearingDegrees,
  cn,
  compassLabel,
  distanceMeters,
  formatDistance,
  formatWhen,
  RARITY_COLOR,
  RARITY_LABEL,
} from '@/lib/utils';

type Here = { lat: number; lng: number; accuracy: number };
type GeoState = 'unknown' | 'granted' | 'prompt' | 'denied' | 'unsupported';
type QuizState = { spawn: Spawn; question: string; options: string[]; message: string; busy: boolean };

const GPS_TOLERANCE = 25;
const POOR_ACCURACY = 50;

export function MapPage() {
  const { me, refresh } = useSession();
  const [spawns, setSpawns] = useState<Spawn[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [here, setHere] = useState<Here | null>(null);
  const [geoState, setGeoState] = useState<GeoState>('unknown');
  const [geoError, setGeoError] = useState('');
  const [geoRetry, setGeoRetry] = useState(0);
  const [actionError, setActionError] = useState('');
  const [pending, setPending] = useState(false);
  const [quiz, setQuiz] = useState<QuizState | null>(null);
  const [reward, setReward] = useState<{ spawn: Spawn; result: CatchResult } | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [showNearby, setShowNearby] = useState(false);
  // The selected protein's question, fetched ahead of time so the Catch tap can open AR straight away.
  const [challenge, setChallenge] = useState<{ id: string; question: string; options: string[] } | null>(null);
  const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN;
  const ar = useAr();
  const arActive = ar.status === 'ar' || ar.status === 'preview';
  const viewLabel = ar.arSupported ? 'View in AR' : 'View in 3D';

  // The player's latest position, for the spawn requests. With cloud cover on, the server only sends the real place
  // of proteins near that position.
  const hereRef = useRef<Here | null>(null);
  hereRef.current = here;
  const fetchedAt = useRef<Here | null>(null);
  const cloudsOn = Boolean(me?.settings?.cloudsEnabled) && !me?.catchAnywhere;
  const cloudDissolve = me?.settings?.cloudDissolveRadius ?? 120;

  // The ground the player has walked through stays cleared of fog. It is kept on the server (so it follows them
  // between devices), loaded once, and a new 25 m square is reported as they walk into it.
  const explored = useMemo(() => new ExploredStore(), []);
  useEffect(() => {
    if (!cloudsOn) return;
    api<ExploredInfo>('/api/explored').then((info) => explored.load(info)).catch(() => undefined);
  }, [cloudsOn, explored]);
  useEffect(() => {
    if (!cloudsOn || !here || here.accuracy > 80) return;
    const cell = explored.cellOf(here.lat, here.lng);
    if (!cell || !explored.add(cell.cx, cell.cy)) return;
    api('/api/explored', { method: 'POST', body: JSON.stringify({ latitude: here.lat, longitude: here.lng }) }).catch(() => undefined);
  }, [cloudsOn, here, explored]);

  useEffect(() => {
    if (arActive) return;
    let stop = false;
    const load = () => {
      const at = hereRef.current;
      fetchedAt.current = at;
      const query = at ? `?lat=${at.lat.toFixed(6)}&lng=${at.lng.toFixed(6)}` : '';
      api<Spawn[]>(`/api/spawns${query}`)
        .then((rows) => {
          if (!stop) setSpawns(rows);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 20_000);
    loadSpawns.current = load;
    return () => {
      stop = true;
      window.clearInterval(timer);
      loadSpawns.current = null;
    };
  }, [arActive]);
  const loadSpawns = useRef<(() => void) | null>(null);

  // Under clouds, ask again once the player has walked a good way (or the first GPS fix arrives), so the proteins
  // that came into range show up without waiting for the next refresh.
  useEffect(() => {
    if (!cloudsOn || !here) return;
    const last = fetchedAt.current;
    if (!last || distanceMeters(last.lat, last.lng, here.lat, here.lng) > 40) loadSpawns.current?.();
  }, [cloudsOn, here]);

  useEffect(() => {
    api<Progress>('/api/progress').then(setProgress).catch(() => undefined);
  }, []);

  // Track the browser's location permission so a denial gets clear instructions rather than a vague error.
  useEffect(() => {
    if (!navigator.geolocation) {
      setGeoState('unsupported');
      return;
    }
    let status: PermissionStatus | null = null;
    const sync = () => status && setGeoState(status.state as GeoState);
    navigator.permissions
      ?.query({ name: 'geolocation' })
      .then((result) => {
        status = result;
        sync();
        result.addEventListener('change', sync);
      })
      .catch(() => undefined);
    return () => status?.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (arActive || !navigator.geolocation) return;
    const watch = navigator.geolocation.watchPosition(
      (position) => {
        setGeoError('');
        setGeoState('granted');
        setHere({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) setGeoState('denied');
        setGeoError(
          error.code === error.PERMISSION_DENIED
            ? 'Location is blocked.'
            : error.code === error.POSITION_UNAVAILABLE
              ? 'Your device could not find its position.'
              : 'Finding your location is taking a while.',
        );
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 12_000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, [arActive, geoRetry]);

  // Under clouds, only proteins the server has revealed (near the player, or on ground they have explored) count as
  // seen: the rest are just glows in the fog.
  const visibleSpawns = useMemo(() => (cloudsOn ? spawns.filter((spawn) => !spawn.hidden) : spawns), [spawns, cloudsOn]);
  const selected = visibleSpawns.find((spawn) => spawn.id === selectedId) ?? null;
  const distance = useMemo(() => {
    if (!selected || !here) return null;
    return distanceMeters(here.lat, here.lng, selected.latitude, selected.longitude);
  }, [selected, here]);
  const reach = selected ? selected.radiusMeters + GPS_TOLERANCE : 0;
  const inRange = distance != null && selected != null && distance <= reach;

  const nearby = useMemo(() => {
    if (!here) return [];
    return visibleSpawns
      .map((spawn) => {
        const meters = distanceMeters(here.lat, here.lng, spawn.latitude, spawn.longitude);
        return {
          spawn,
          meters,
          bearing: bearingDegrees(here.lat, here.lng, spawn.latitude, spawn.longitude),
          inRange: meters <= spawn.radiusMeters + GPS_TOLERANCE,
        };
      })
      .sort((a, b) => a.meters - b.meters);
  }, [visibleSpawns, here]);
  const nearestWild = nearby.find((entry) => !entry.spawn.caught) ?? null;

  // Start downloading the model as soon as a protein is selected, so Catch / View Model can open AR instantly.
  const { prepare } = ar;
  useEffect(() => {
    if (selected?.hasModel) prepare(selected);
  }, [selected, prepare]);

  const selectedQuizId = selected && selected.hasQuiz && !selected.caught ? selected.id : null;
  useEffect(() => {
    if (!selectedQuizId) {
      setChallenge(null);
      return;
    }
    let stop = false;
    setChallenge((current) => (current?.id === selectedQuizId ? current : null));
    api<{ question: string; options: string[] }>(`/api/spawns/${selectedQuizId}/challenge`)
      .then((data) => {
        if (!stop) setChallenge({ id: selectedQuizId, ...data });
      })
      // Could not load it: leave an empty one so Catch falls back to asking on the map (which shows the error).
      .catch(() => {
        if (!stop) setChallenge({ id: selectedQuizId, question: '', options: [] });
      });
    return () => {
      stop = true;
    };
  }, [selectedQuizId]);

  const modelReady = selected != null && ar.preparedId === selected.id && ar.status !== 'loading' && ar.status !== 'idle';
  const modelLoading = selected != null && ar.preparedId === selected.id && ar.status === 'loading';
  const loadingLabel = ar.progress >= 0 ? `Loading model ${Math.round(ar.progress * 100)}%` : 'Loading model…';

  // A quiz protein with a model asks its question in AR, so the question has to be here before the tap.
  // (On iPhone Safari the question is asked after the hand-off to the App Clip, so it need not be ready here.)
  const waitingForQuestion = Boolean(
    !ar.launchRequired && selected && selected.hasQuiz && !selected.caught && selected.hasModel && challenge?.id !== selected.id,
  );

  const select = useCallback((id: string) => {
    setSelectedId(id);
    setActionError('');
    setReward(null);
    setShowNearby(false);
  }, []);

  // Arriving from the Variant Launch App Clip with ?vlspawn=<id>: open that protein so Catch is one tap away.
  const deepLinkRef = useRef(new URLSearchParams(window.location.search).get('vlspawn'));
  useEffect(() => {
    const id = deepLinkRef.current;
    if (!id || spawns.length === 0) return;
    deepLinkRef.current = null;
    if (spawns.some((spawn) => spawn.id === id)) select(id);
    const url = new URL(window.location.href);
    url.searchParams.delete('vlspawn');
    window.history.replaceState(null, '', url);
  }, [spawns, select]);

  function applyCaught(spawn: Spawn, result: CatchResult) {
    setSpawns((current) => current.map((item) => (item.id === spawn.id ? { ...item, caught: true } : item)));
    setProgress(result.progress);
    if (!result.already) setReward({ spawn, result });
  }

  function catchBody(extra: { answer?: number } = {}) {
    return JSON.stringify({
      ...(here ? { latitude: here.lat, longitude: here.lng, accuracy: here.accuracy } : {}),
      ...extra,
    });
  }

  // Catching opens the AR view. Browsers only start AR right after a tap, so for spawns without a quiz it opens
  // immediately and the catch result follows: if the server turns the catch down, AR closes and the reason is shown.
  // Quiz spawns ask the question first, then the catch is sent with the answer.
  function catchSelected() {
    if (!selected || (!here && !me?.catchAnywhere)) return;
    const spawn = selected;
    setActionError('');
    setReward(null);
    if (ar.launchRequired && spawn.hasModel) {
      // iPhone Safari: one tap goes straight to the App Clip, where the question and the catch happen.
      ar.enter();
      return;
    }
    if (spawn.hasQuiz && spawn.hasModel && modelReady && challenge?.id === spawn.id && challenge.options.length >= 2) {
      // The question is asked in AR itself, on a panel next to the protein. The catch is sent with the answer.
      ar.enter({
        challenge: { question: challenge.question, options: challenge.options },
        onAnswer: (index) => answerInAr(spawn, index),
      });
      return;
    }
    if (spawn.hasQuiz) {
      // No model to show it on: ask on the map instead.
      setPending(true);
      api<{ question: string; options: string[] }>(`/api/spawns/${spawn.id}/challenge`)
        .then((challenge) => setQuiz({ spawn, question: challenge.question, options: challenge.options, message: '', busy: false }))
        .catch((error: unknown) => setActionError(error instanceof ApiError ? error.message : 'Could not load the question.'))
        .finally(() => setPending(false));
      return;
    }
    const opensAr = spawn.hasModel && modelReady;
    setPending(true);
    const request = api<CatchResult>(`/api/spawns/${spawn.id}/catch`, { method: 'POST', body: catchBody() });
    if (opensAr) ar.enter();
    request
      .then((result) => applyCaught(spawn, result))
      .catch((error: unknown) => {
        if (opensAr) ar.exit();
        setActionError(error instanceof ApiError ? error.message : 'Catch failed.');
      })
      .finally(() => setPending(false));
  }

  /** An answer given in AR: sends the catch and tells the AR panel how it went. */
  async function answerInAr(spawn: Spawn, index: number): Promise<ChallengeOutcome> {
    try {
      const result = await api<CatchResult>(`/api/spawns/${spawn.id}/catch`, {
        method: 'POST',
        body: catchBody({ answer: index }),
      });
      applyCaught(spawn, result);
      if (result.already) return { ok: true, message: 'Already caught!' };
      return { ok: true, message: `Caught! +${result.xp + result.bonus} XP${result.leveledUp ? ' · Level up!' : ''}` };
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Catch failed.';
      // A wrong answer or a cool-down: stay in AR and let them try again. Anything else ends the session.
      if (error instanceof ApiError && (error.status === 422 || error.status === 429)) {
        return { ok: false, message, retryAfterMs: 5000 };
      }
      return { ok: false, message, fatal: true };
    }
  }

  function answer(index: number) {
    if (!quiz || quiz.busy) return;
    const { spawn } = quiz;
    setQuiz({ ...quiz, busy: true, message: '' });
    api<CatchResult>(`/api/spawns/${spawn.id}/catch`, { method: 'POST', body: catchBody({ answer: index }) })
      .then((result) => {
        setQuiz(null);
        applyCaught(spawn, result);
        if (spawn.hasModel && ar.preparedId === spawn.id && ar.status !== 'loading' && ar.status !== 'idle') ar.enter();
      })
      .catch((error: unknown) => {
        const message = error instanceof ApiError ? error.message : 'Catch failed.';
        if (error instanceof ApiError && (error.status === 422 || error.status === 429)) {
          setQuiz((current) => (current ? { ...current, busy: false, message } : current));
        } else {
          setQuiz(null);
          setActionError(message);
        }
      });
  }

  function dismissReward() {
    setReward(null);
    void refresh().catch(() => undefined);
  }

  const navItems: NavItem[] = [
    { to: '/collection', label: 'Collection' },
    ...(me?.settings?.leaderboardEnabled ? [{ to: '/leaderboard', label: 'Leaderboard' }] : []),
    ...(me?.isAdmin ? [{ to: '/admin', label: 'Admin' }] : []),
  ];

  const locationHelp =
    geoState === 'denied' ? (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
        <p className="font-medium text-destructive">Location is blocked.</p>
        <p className="mt-1 text-muted-foreground">
          Catching needs your location. Tap the lock or site-settings icon next to the address bar, allow Location, then
          retry. On iPhone: Settings → Privacy → Location Services → your browser → While Using.
        </p>
        <Button size="sm" className="mt-2" onClick={() => setGeoRetry((count) => count + 1)}>
          Retry
        </Button>
      </div>
    ) : geoState === 'unsupported' ? (
      <p className="text-sm text-muted-foreground">This browser cannot share your location, so you cannot catch here.</p>
    ) : !here ? (
      <p className="text-xs text-muted-foreground">
        {geoError ||
          (geoState === 'prompt'
            ? 'Allow location when your browser asks. It is only used to check you are near a protein.'
            : 'Finding you…')}
        {geoError ? (
          <button className="ml-2 underline" onClick={() => setGeoRetry((count) => count + 1)}>
            Retry
          </button>
        ) : null}
      </p>
    ) : here.accuracy > POOR_ACCURACY ? (
      <p className="text-xs text-amber-700">
        GPS is rough (±{Math.round(here.accuracy)} m). Step into the open for a better fix before catching.
      </p>
    ) : (
      <p className="text-xs text-muted-foreground">GPS ±{Math.round(here.accuracy)} m</p>
    );

  return (
    <div className="flex h-dvh flex-col bg-campus">
      <header className="relative z-40 flex h-14 shrink-0 items-center justify-between gap-3 px-4 text-primary-foreground">
        <div className="min-w-0">
          <p className="font-display text-lg leading-none">ProteinGo</p>
          <p className="truncate text-xs text-primary-foreground/70">
            {progress
              ? `Level ${progress.level} · ${progress.xp} XP · ${progress.caught}/${progress.totalSpawns} caught`
              : me?.access.active && me.access.expiresAt
                ? `${me.access.label ?? 'Code'} until ${formatWhen(me.access.expiresAt)}`
                : me?.user.email}
          </p>
        </div>
        <HeaderNav items={navItems} onSignOut={() => void signOutEverywhere()} />
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
            flyToSelected
            rarityColors={me?.settings?.rarityEnabled !== false}
            explored={cloudsOn ? explored : null}
            clouds={
              cloudsOn
                ? {
                    dissolveRadius: cloudDissolve,
                    hintRadius: me?.settings?.cloudHintRadius ?? 350,
                    transparency: me?.settings?.cloudTransparency ?? 15,
                  }
                : null
            }
            onSelect={select}
          />
        ) : (
          <div className="grid h-full content-start gap-2 overflow-auto p-4 pb-64 md:pb-4 md:pr-[22rem]">
            <p className="text-sm text-muted-foreground">
              Add VITE_MAPBOX_TOKEN to show the campus map. Spawns are listed here until then.
            </p>
            {visibleSpawns.map((spawn) => (
              <button
                key={spawn.id}
                className={cn('rounded-lg border bg-card px-3 py-2 text-left', spawn.id === selectedId && 'border-primary')}
                onClick={() => select(spawn.id)}
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

        {nearestWild && !selected ? (
          <button
            className="absolute top-3 left-3 z-30 flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-sm shadow-lg"
            onClick={() => select(nearestWild.spawn.id)}
          >
            <span
              className="inline-block text-lg leading-none"
              style={{ transform: `rotate(${Math.round(nearestWild.bearing)}deg)` }}
              aria-hidden
            >
              ↑
            </span>
            <span>
              {nearestWild.inRange ? (
                <b>{nearestWild.spawn.name} is in range</b>
              ) : (
                <>
                  <b>{nearestWild.spawn.name}</b> {formatDistance(nearestWild.meters)} {compassLabel(nearestWild.bearing)}
                </>
              )}
            </span>
          </button>
        ) : null}

        <aside className="absolute z-30 inset-x-3 bottom-3 max-h-[70%] overflow-auto rounded-xl border bg-card p-4 shadow-lg md:inset-x-auto md:top-4 md:right-4 md:bottom-auto md:w-80">
          {!selected ? (
            <div className="grid gap-3">
              <div>
                <p className="font-medium">Proteins on campus</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {spawns.length === 0
                    ? 'Nothing is placed right now.'
                    : me?.settings?.rarityEnabled === false
                      ? `${spawns.length} on the map. Faded ones are caught.`
                      : `${spawns.length} on the map. Color shows rarity; faded ones are caught.`}
                </p>
              </div>
              {progress ? <XpBar progress={progress} /> : null}
              {locationHelp}
              {spawns.length > 0 ? (
                <div>
                  <button
                    className="text-sm font-medium underline"
                    onClick={() => setShowNearby((open) => !open)}
                  >
                    {showNearby ? 'Hide nearby list' : 'Show nearby list'}
                  </button>
                  {showNearby ? (
                    <ul className="mt-2 grid gap-1.5">
                      {(here ? nearby : visibleSpawns.map((spawn) => ({ spawn, meters: null, bearing: 0, inRange: false }))).map(
                        (entry) => (
                          <li key={entry.spawn.id}>
                            <button
                              className="flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left text-sm"
                              onClick={() => select(entry.spawn.id)}
                            >
                              <span className="min-w-0 truncate">
                                {entry.spawn.name}
                                {entry.spawn.caught ? <span className="text-emerald-700"> ✓</span> : null}
                              </span>
                              <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                                {entry.inRange ? <Badge variant="good">In range</Badge> : null}
                                {entry.meters != null ? (
                                  <>
                                    <span style={{ display: 'inline-block', transform: `rotate(${Math.round(entry.bearing)}deg)` }}>
                                      ↑
                                    </span>
                                    {formatDistance(entry.meters)}
                                  </>
                                ) : null}
                              </span>
                            </button>
                          </li>
                        ),
                      )}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="grid gap-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="font-display text-2xl leading-none">{selected.name}</h2>
                  {selected.summary ? <p className="mt-1 text-sm text-muted-foreground">{selected.summary}</p> : null}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <Badge variant={selected.caught ? 'good' : 'gold'}>{selected.caught ? 'Caught' : 'Wild'}</Badge>
                  {me?.settings?.rarityEnabled === false ? null : (
                    <Badge className={RARITY_COLOR[selected.rarity]}>{RARITY_LABEL[selected.rarity]}</Badge>
                  )}
                </div>
              </div>
              <p className="text-sm">
                {distance == null
                  ? 'Waiting for GPS.'
                  : inRange
                    ? `In range · ${formatDistance(distance)} away`
                    : `${formatDistance(Math.max(0, distance - reach))} to go · ${formatDistance(distance)} away · catch within ${selected.radiusMeters} m`}
              </p>
              {here && here.accuracy > POOR_ACCURACY ? (
                <p className="text-xs text-amber-700">GPS is rough (±{Math.round(here.accuracy)} m), so range may be off.</p>
              ) : null}
              {geoState === 'denied' ? locationHelp : null}
              <p className="text-xs text-muted-foreground">
                {selected.xp} XP{selected.hasQuiz && !selected.caught ? (selected.hasModel ? ' · answer a question in AR to catch it' : ' · answer a question to catch it') : ''}
                {selected.styles.length > 1 ? ' · spheres and ribbon views' : ''}
              </p>
              {!selected.hasModel ? (
                <p className="text-xs text-muted-foreground">No model attached. Add one in /admin.</p>
              ) : null}
              {ar.error ? <p className="text-sm text-destructive">{ar.error}</p> : null}
              {actionError ? <p className="text-sm text-destructive">{actionError}</p> : null}
              {reward && reward.spawn.id === selected.id ? <RewardCard reward={reward} onClose={dismissReward} /> : null}
              <div className="flex gap-2">
                {selected.caught ? (
                  <Button disabled={!selected.hasModel || !(modelReady || ar.launchRequired)} onClick={() => ar.enter()}>
                    {modelLoading ? loadingLabel : selected.hasModel ? viewLabel : 'No model yet'}
                  </Button>
                ) : (
                  <Button
                    disabled={pending || (!inRange && !me?.catchAnywhere) || modelLoading || waitingForQuestion}
                    onClick={catchSelected}
                  >
                    {modelLoading ? loadingLabel : pending ? 'Catching…' : waitingForQuestion ? 'Loading question…' : 'Catch'}
                  </Button>
                )}
                <Button variant="ghost" onClick={() => setSelectedId(null)}>
                  Close
                </Button>
              </div>
            </div>
          )}
        </aside>

        {quiz ? (
          <div className="absolute inset-0 z-40 grid place-items-center bg-black/50 p-4">
            <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-xl border bg-card p-5 shadow-xl">
              <p className="text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                Catch {quiz.spawn.name}
              </p>
              <h2 className="mt-1 font-display text-2xl leading-snug">{quiz.question}</h2>
              <div className="mt-4 grid gap-2">
                {quiz.options.map((option, index) => (
                  <Button
                    key={index}
                    variant="outline"
                    className="h-auto justify-start whitespace-normal px-4 py-3 text-left"
                    disabled={quiz.busy}
                    onClick={() => answer(index)}
                  >
                    {option}
                  </Button>
                ))}
              </div>
              {quiz.message ? <p className="mt-3 text-sm text-destructive">{quiz.message}</p> : null}
              <Button className="mt-4" variant="ghost" onClick={() => setQuiz(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RewardCard({ reward, onClose }: { reward: { spawn: Spawn; result: CatchResult }; onClose: () => void }) {
  const { result } = reward;
  return (
    <div className="rounded-lg border border-gold bg-gold/15 p-3 text-sm">
      <p className="font-display text-xl">Caught {reward.spawn.name}!</p>
      <p className="mt-1">
        +{result.xp} XP{result.bonus > 0 ? ` (includes +${result.bonus} first-try bonus)` : ''}
      </p>
      {result.leveledUp ? <p className="mt-1 font-semibold text-emerald-800">Level up! You are now level {result.progress.level}.</p> : null}
      <Button size="sm" variant="outline" className="mt-2" onClick={onClose}>
        Nice
      </Button>
    </div>
  );
}
