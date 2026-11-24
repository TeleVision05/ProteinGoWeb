/** Settings an admin controls. The cloud numbers are meters, except transparency (percent). */
export type AppSettings = {
  leaderboardEnabled: boolean;
  rarityEnabled: boolean;
  cloudsEnabled: boolean;
  cloudDissolveRadius: number;
  cloudHintRadius: number;
  cloudTransparency: number;
};

/** Allowed ranges for the cloud numbers (the server checks the same ones). */
export const CLOUD_LIMITS = {
  dissolveRadius: { min: 20, max: 1000 },
  hintRadius: { min: 50, max: 3000 },
  transparency: { min: 0, max: 90 },
} as const;

export type Me = {
  user: { id: string; name: string; email: string; image: string | null };
  isAdmin: boolean;
  access: { active: boolean; expiresAt: string | null; label: string | null };
  /** Test switch: catching needs no location. */
  catchAnywhere?: boolean;
  settings?: AppSettings;
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
  /** Assignments this catch just finished. */
  completed?: { id: string; title: string; code: string }[];
};

/** What a student sees for an assignment: progress and, once every protein is caught, the code to hand in. */
export type MyAssignment = {
  id: string;
  title: string;
  dueAt: string | null;
  total: number;
  caught: number;
  done: boolean;
  completedAt: string | null;
  late: boolean;
  code: string | null;
  proteins: { id: string; name: string; caught: boolean; caughtAt: string | null }[];
};

export type AdminAssignment = {
  id: string;
  title: string;
  dueAt: string | null;
  createdAt: string;
  spawns: { id: string; name: string }[];
};

export type RosterStudent = {
  userId: string;
  name: string;
  email: string;
  sections: string[];
  caught: number;
  xp: number;
  firstTry: number;
  wrongAnswers: number;
  lastCatch: string | null;
  assignment: {
    caught: number;
    total: number;
    done: boolean;
    completedAt: string | null;
    late: boolean;
    code: string | null;
  } | null;
};

export type RosterQuestion = {
  spawnId: string;
  name: string;
  question: string;
  students: number;
  caught: number;
  firstTryPercent: number | null;
  wrongAnswers: number;
  topWrong: { answer: string; count: number } | null;
};

export type Roster = { assignment: AdminAssignment | null; students: RosterStudent[]; questions: RosterQuestion[] };

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
  /** Under the cloud cover: latitude and longitude are only a rough hint, not the real spot. Never shown as a marker. */
  hidden?: boolean;
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
