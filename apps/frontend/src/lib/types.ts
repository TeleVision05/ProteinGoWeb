export type Me = {
  user: { id: string; name: string; email: string; image: string | null };
  isAdmin: boolean;
  access: { active: boolean; expiresAt: string | null; label: string | null };
  /** Test switch: catching needs no location. */
  catchAnywhere?: boolean;
  settings?: { leaderboardEnabled: boolean; rarityEnabled: boolean };
};

export type Rarity = 'common' | 'uncommon' | 'rare' | 'legendary';
export type StyleName = 'sphere' | 'ribbon';
export type ModelStyle = { style: StyleName; url: string; lowUrl: string | null; filename: string | null };
export type Quiz = { question: string; options: string[]; answerIndex: number };

export type Achievement = {
  id: string;
  title: string;
  description: string;
  unlocked: boolean;
  progress: number;
  target: number;
};

export type Progress = {
  xp: number;
  level: number;
  levelXp: number;
  levelSpan: number;
  caught: number;
  totalSpawns: number;
  streak: number;
  bestStreak: number;
  rank: number | null;
  achievements: Achievement[];
};

export type CollectionItem = {
  id: string;
  name: string;
  summary: string | null;
  rarity: Rarity;
  xp: number;
  caught: boolean;
  caughtAt: string | null;
  hasModel: boolean;
  expired: boolean;
  styles: ModelStyle[];
  defaultStyle: StyleName | null;
};

export type Leaderboard = {
  enabled: boolean;
  entries: { rank: number; name: string; xp: number; level: number; caught: number; isMe: boolean }[];
  me: { rank: number; xp: number; level: number; caught: number } | null;
};

export type CatchResult = {
  caught: true;
  already: boolean;
  xp: number;
  bonus: number;
  leveledUp: boolean;
  progress: Progress;
};

export type Spawn = {
  id: string;
  name: string;
  summary: string | null;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  expiresAt: string | null;
  createdAt: string;
  hasModel: boolean;
  modelUrl: string | null;
  modelFilename: string | null;
  caught: boolean;
  rarity: Rarity;
  xp: number;
  hasQuiz: boolean;
  defaultStyle: StyleName | null;
  styles: ModelStyle[];
  catchCount?: number;
  quiz?: Quiz | null;
};

export type AccessCode = {
  id: string;
  code: string;
  label: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  redemptions: number;
  status: 'active' | 'expired' | 'revoked';
};
