// Pure game-progress rules (no database): XP, levels, streaks, achievements.

export type Rarity = 'common' | 'uncommon' | 'rare' | 'legendary';
export const RARITIES: Rarity[] = ['common', 'uncommon', 'rare', 'legendary'];
export const RARITY_XP: Record<Rarity, number> = { common: 10, uncommon: 25, rare: 50, legendary: 100 };
/** Share of the reward added when a quiz is answered right on the first try. */
export const FIRST_TRY_BONUS = 0.5;

export function isRarity(value: unknown): value is Rarity {
  return typeof value === 'string' && (RARITIES as string[]).includes(value);
}

export function rewardFor(rarity: string, firstTryQuiz: boolean) {
  const xp = RARITY_XP[isRarity(rarity) ? rarity : 'common'];
  const bonus = firstTryQuiz ? Math.round(xp * FIRST_TRY_BONUS) : 0;
  return { xp, bonus };
}

/** Level 1 starts at 0 XP; level n starts at 50 * (n-1)^2 XP. */
export function levelStart(level: number) {
  return 50 * (level - 1) ** 2;
}

export function levelFor(xp: number) {
  const safe = Math.max(0, xp);
  let level = Math.floor(Math.sqrt(safe / 50)) + 1;
  while (levelStart(level + 1) <= safe) level++;
  while (level > 1 && levelStart(level) > safe) level--;
  return {
    level,
    levelXp: safe - levelStart(level),
    levelSpan: levelStart(level + 1) - levelStart(level),
  };
}

function dayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

/** Consecutive-day catch streaks. The current streak survives until the end of the day after the last catch. */
export function streaks(dates: Date[], now = new Date()) {
  const days = [...new Set(dates.map(dayKey))].sort();
  let best = 0;
  let run = 0;
  let previous: number | null = null;
  const dayMs = 86_400_000;
  for (const day of days) {
    const time = Date.parse(`${day}T00:00:00Z`);
    run = previous != null && time - previous === dayMs ? run + 1 : 1;
    best = Math.max(best, run);
    previous = time;
  }
  let current = 0;
  if (days.length && previous != null) {
    const today = Date.parse(`${dayKey(now)}T00:00:00Z`);
    if (today - previous <= dayMs) current = run;
  }
  return { current, best };
}

export type ProgressStats = {
  caught: number;
  /** Caught proteins that are still on campus. */
  activeCaught: number;
  totalSpawns: number;
  streak: number;
  bestStreak: number;
  byRarity: Record<Rarity, number>;
  firstTryQuizzes: number;
};

type AchievementDef = {
  id: string;
  title: string;
  description: string;
  target: number;
  value: (stats: ProgressStats) => number;
};

const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first-catch', title: 'First catch', description: 'Catch your first protein.', target: 1, value: (s) => s.caught },
  { id: 'collector-5', title: 'Collector', description: 'Catch 5 proteins.', target: 5, value: (s) => s.caught },
  { id: 'collector-10', title: 'Curator', description: 'Catch 10 proteins.', target: 10, value: (s) => s.caught },
  { id: 'collector-25', title: 'Archivist', description: 'Catch 25 proteins.', target: 25, value: (s) => s.caught },
  { id: 'rare-find', title: 'Rare find', description: 'Catch a rare protein.', target: 1, value: (s) => s.byRarity.rare + s.byRarity.legendary },
  { id: 'legend', title: 'Legend hunter', description: 'Catch a legendary protein.', target: 1, value: (s) => s.byRarity.legendary },
  { id: 'sharp', title: 'Sharp mind', description: 'Answer 3 quizzes right on the first try.', target: 3, value: (s) => s.firstTryQuizzes },
  { id: 'streak-3', title: 'On a roll', description: 'Catch on 3 days in a row.', target: 3, value: (s) => s.bestStreak },
  { id: 'streak-7', title: 'Regular', description: 'Catch on 7 days in a row.', target: 7, value: (s) => s.bestStreak },
  {
    id: 'full-set',
    title: 'Full set',
    description: 'Catch every protein on campus (needs at least 3).',
    target: 1,
    value: (s) => (s.totalSpawns >= 3 && s.activeCaught >= s.totalSpawns ? 1 : 0),
  },
];

export function buildAchievements(stats: ProgressStats) {
  return ACHIEVEMENTS.map((def) => {
    const value = def.value(stats);
    return {
      id: def.id,
      title: def.title,
      description: def.description,
      unlocked: value >= def.target,
      progress: Math.min(value, def.target),
      target: def.target,
    };
  });
}

/** "Alex Rivera" -> "Alex R." so a public board does not print full names. */
export function publicName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Player';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}
