import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';
import type { Leaderboard } from '@/lib/types';
import { cn } from '@/lib/utils';

export function LeaderboardPage() {
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Leaderboard>('/api/leaderboard')
      .then(setBoard)
      .catch((caught) => setError(caught instanceof ApiError ? caught.message : 'Could not load the leaderboard.'));
  }, []);

  return (
    <main className="mx-auto grid max-w-2xl gap-6 px-4 py-8">
      <header className="flex items-end justify-between gap-3">
        <h1 className="font-display text-4xl">Leaderboard</h1>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link to="/collection">Collection</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/">Map</Link>
          </Button>
        </div>
      </header>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {board && !board.enabled ? <p className="text-sm text-muted-foreground">Leaderboard is off.</p> : null}
      {board?.enabled ? (
        <Card>
          <CardContent className="grid gap-1.5">
            {board.entries.length === 0 ? <p className="text-sm text-muted-foreground">No catches yet.</p> : null}
            {board.entries.map((entry) => (
              <div
                key={entry.rank}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2',
                  entry.isMe ? 'bg-gold/25 font-semibold' : 'odd:bg-secondary/50',
                )}
              >
                <span className="w-8 text-right font-display text-lg">{entry.rank}</span>
                <span className="min-w-0 flex-1 truncate">
                  {entry.name}
                  {entry.isMe ? ' (you)' : ''}
                </span>
                <span className="text-xs text-muted-foreground">
                  Lv {entry.level} · {entry.caught} caught
                </span>
                <span className="w-16 text-right text-sm">{entry.xp} XP</span>
              </div>
            ))}
            {board.me && !board.entries.some((entry) => entry.isMe) ? (
              <p className="mt-2 border-t pt-2 text-sm">
                You: #{board.me.rank} · Lv {board.me.level} · {board.me.xp} XP
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </main>
  );
}
