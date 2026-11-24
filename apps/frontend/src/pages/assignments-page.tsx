import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';
import { toast } from '@/lib/toast';
import type { MyAssignment } from '@/lib/types';
import { formatWhen } from '@/lib/utils';

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Code copied.');
  } catch {
    toast.error('Could not copy. Select the code and copy it by hand.');
  }
}

function AssignmentCard({ item }: { item: MyAssignment }) {
  const percent = item.total ? Math.round((item.caught / item.total) * 100) : 0;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle>{item.title}</CardTitle>
          {item.done ? <Badge variant="gold">Done</Badge> : <Badge variant="muted">{item.caught}/{item.total}</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">
          {item.dueAt ? `Due ${formatWhen(item.dueAt)}. ` : ''}Catch every protein below{item.dueAt ? '' : ', no deadline'}.
        </p>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div
          className="h-2 overflow-hidden rounded-full bg-secondary"
          role="progressbar"
          aria-valuenow={item.caught}
          aria-valuemin={0}
          aria-valuemax={item.total}
          aria-label={`${item.caught} of ${item.total} proteins caught`}
        >
          <div className="h-full rounded-full bg-gold transition-all" style={{ width: `${percent}%` }} />
        </div>
        <ul className="grid gap-1.5">
          {item.proteins.map((protein) => (
            <li key={protein.id} className="flex items-center gap-3 rounded-lg px-3 py-2 odd:bg-secondary/50">
              <span aria-hidden className={protein.caught ? 'text-emerald-700' : 'text-muted-foreground'}>
                {protein.caught ? '✓' : '○'}
              </span>
              <span className="min-w-0 flex-1 truncate">{protein.name}</span>
              <span className="text-xs text-muted-foreground">
                {protein.caughtAt ? `Caught ${formatWhen(protein.caughtAt)}` : 'Not caught yet'}
              </span>
            </li>
          ))}
        </ul>
        {item.done && item.code ? (
          <div className="grid gap-2 rounded-lg border border-gold/60 bg-gold/15 p-4">
            <p className="text-sm font-medium">
              Completed {item.completedAt ? formatWhen(item.completedAt) : ''}
              {item.late ? ' (after the due date)' : ''}. Hand in this code:
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-display text-3xl tracking-[0.12em] select-all">{item.code}</span>
              <Button size="sm" variant="outline" onClick={() => void copy(item.code ?? '')}>
                Copy
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function AssignmentsPage() {
  const [items, setItems] = useState<MyAssignment[] | null>(null);

  useEffect(() => {
    api<MyAssignment[]>('/api/assignments')
      .then(setItems)
      .catch((caught) => {
        setItems([]);
        toast.error(caught instanceof ApiError ? caught.message : 'Could not load your assignments.');
      });
  }, []);

  return (
    <main className="mx-auto grid max-w-2xl gap-6 px-4 py-8">
      <header className="flex items-end justify-between gap-3">
        <h1 className="font-display text-4xl">Assignments</h1>
        <Button asChild variant="outline">
          <Link to="/">Map</Link>
        </Button>
      </header>
      {items && items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Your instructor has not set an assignment yet. You can still catch proteins on the map.</p>
      ) : null}
      {items?.map((item) => <AssignmentCard key={item.id} item={item} />)}
    </main>
  );
}
