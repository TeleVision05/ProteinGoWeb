import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { XpBar } from '@/components/xp-bar';
import { api, ApiError } from '@/lib/api';
import type { CollectionItem, Progress } from '@/lib/types';
import { cn, formatWhen, RARITY_COLOR, RARITY_LABEL, RARITY_ORDER } from '@/lib/utils';

function styleSummary(item: CollectionItem) {
  const names = item.styles.map((entry) => entry.style);
  if (names.includes('sphere') && names.includes('ribbon')) return 'Spheres + Ribbon';
  if (names.includes('ribbon')) return 'Ribbon';
  if (names.includes('sphere')) return 'Spheres';
  return item.hasModel ? 'Model' : 'No model';
}

export function CollectionPage() {
  const { me } = useSession();
  const rarityOn = me?.settings?.rarityEnabled !== false;
  const [items, setItems] = useState<CollectionItem[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [filter, setFilter] = useState<'all' | (typeof RARITY_ORDER)[number]>('all');
  const [showOnly, setShowOnly] = useState<'all' | 'caught' | 'missing'>('all');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api<{ items: CollectionItem[]; progress: Progress }>('/api/collection')
      .then((data) => {
        setItems(data.items);
        setProgress(data.progress);
      })
      .catch((caught) => setError(caught instanceof ApiError ? caught.message : 'Could not load your collection.'))
      .finally(() => setLoaded(true));
  }, []);

  const visible = useMemo(
    () =>
      items.filter(
        (item) =>
          (filter === 'all' || item.rarity === filter) &&
          (showOnly === 'all' || (showOnly === 'caught' ? item.caught : !item.caught)),
      ),
    [items, filter, showOnly],
  );
  const caughtCount = items.filter((item) => item.caught).length;

  return (
    <main className="mx-auto grid max-w-5xl gap-6 px-4 py-8">
      <header className="flex items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase">
            {me?.user.name ?? 'Your'}
          </p>
          <h1 className="font-display text-4xl">Collection</h1>
        </div>
        <div className="flex gap-2">
          {me?.settings?.leaderboardEnabled ? (
            <Button asChild variant="outline">
              <Link to="/leaderboard">Leaderboard</Link>
            </Button>
          ) : null}
          <Button asChild variant="outline">
            <Link to="/">Back to map</Link>
          </Button>
        </div>
      </header>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {progress ? (
        <Card>
          <CardContent className="grid gap-4">
            <XpBar progress={progress} />
            <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
              <Stat label="Caught" value={`${progress.caught} / ${progress.totalSpawns}`} />
              <Stat label="Day streak" value={`${progress.streak}`} hint={`best ${progress.bestStreak}`} />
              <Stat label="Rank" value={progress.rank ? `#${progress.rank}` : '—'} />
              <Stat label="XP" value={`${progress.xp}`} />
            </div>
          </CardContent>
        </Card>
      ) : null}

      {progress ? (
        <section className="grid gap-3">
          <h2 className="font-display text-2xl">Achievements</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {progress.achievements.map((a) => (
              <div
                key={a.id}
                className={cn('rounded-xl border bg-card p-3', a.unlocked ? 'border-gold' : 'opacity-70')}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold">{a.title}</p>
                  <Badge variant={a.unlocked ? 'gold' : 'muted'}>{a.unlocked ? 'Unlocked' : `${a.progress}/${a.target}`}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{a.description}</p>
                {!a.unlocked ? (
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full bg-primary"
                      style={{ width: `${Math.min(100, (a.progress / Math.max(1, a.target)) * 100)}%` }}
                    />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-2xl">
            Proteins{' '}
            <span className="text-base text-muted-foreground">
              {caughtCount} / {items.length}
            </span>
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {rarityOn ? (
              <>
                {(['all', ...RARITY_ORDER] as const).map((value) => (
                  <Button key={value} size="sm" variant={filter === value ? 'default' : 'outline'} onClick={() => setFilter(value)}>
                    {value === 'all' ? 'All' : RARITY_LABEL[value]}
                  </Button>
                ))}
                <span className="mx-1 w-px bg-border" />
              </>
            ) : null}
            {(['all', 'caught', 'missing'] as const).map((value) => (
              <Button key={value} size="sm" variant={showOnly === value ? 'default' : 'outline'} onClick={() => setShowOnly(value)}>
                {value === 'all' ? 'Any' : value === 'caught' ? 'Caught' : 'Missing'}
              </Button>
            ))}
          </div>
        </div>
        {loaded && visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing matches that filter.</p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((item) => (
            <div
              key={item.id}
              className={cn('rounded-xl border bg-card p-4', item.caught ? 'border-emerald-700/60' : 'opacity-80')}
            >
              <div className="flex items-start justify-between gap-2">
                <p className={cn('font-display text-xl leading-tight', !item.caught && 'text-muted-foreground')}>{item.name}</p>
                {rarityOn ? <Badge className={RARITY_COLOR[item.rarity]}>{RARITY_LABEL[item.rarity]}</Badge> : null}
              </div>
              {item.summary ? <p className="mt-1 text-sm text-muted-foreground">{item.summary}</p> : null}
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant={item.caught ? 'good' : 'muted'}>{item.caught ? 'Caught' : item.expired ? 'Gone' : 'Not yet'}</Badge>
                <span>{item.xp} XP</span>
                <span>· {styleSummary(item)}</span>
                {item.caughtAt ? <span>· {formatWhen(item.caughtAt)}</span> : null}
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg bg-secondary px-2 py-2">
      <p className="text-lg font-semibold">{value}</p>
      <p className="text-xs text-muted-foreground">
        {label}
        {hint ? ` · ${hint}` : ''}
      </p>
    </div>
  );
}
