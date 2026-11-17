import type { Progress } from '@/lib/types';

export function XpBar({ progress }: { progress: Pick<Progress, 'level' | 'levelXp' | 'levelSpan' | 'xp'> }) {
  const pct = progress.levelSpan > 0 ? Math.min(100, (progress.levelXp / progress.levelSpan) * 100) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-display text-2xl">Level {progress.level}</span>
        <span className="text-muted-foreground">
          {progress.levelXp} / {progress.levelSpan} XP · {progress.xp} total
        </span>
      </div>
      <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-secondary">
        <div className="h-full rounded-full bg-gold transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
