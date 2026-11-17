// Fills a fresh dev database with something to play: dev accounts, a class code, proteins around UCR
// (with models, quizzes and rarities), and a few fake players so the collection and leaderboard have data.
//
//   npm run seed          (from apps/server, or `npm run seed` at the repo root)
//
// Safe to run again: it replaces what an earlier run made and leaves everything else alone.
import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { user } from '../db/auth-schema';
import { db, pool } from '../db/db';
import { accessCode, capture, spawn } from '../db/game-schema';
import { devUser } from '../dev-auth';
import { createSpawn, deleteSpawn, updateSettings, type ModelFiles, type ModelUpload } from '../game';
import { rewardFor } from '../progress';

const SEED_USER = 'seed-bot';
const DEMO_CODE = 'DEMO2026';
const MODELS_DIR = path.resolve(process.cwd(), '../frontend/public/ar/models');

type Rarity = 'common' | 'uncommon' | 'rare' | 'legendary';

type Plan = {
  name: string;
  note: string;
  latitude: number;
  longitude: number;
  rarity: Rarity;
  /** Model group in the library (e.g. actin-myosin). */
  group?: string;
  quiz?: { question: string; options: string[]; answerIndex: number };
};

// Spots on and around the UCR campus. Positions are approximate: nudge them in /admin.
const PLANS: Plan[] = [
  {
    name: 'Hemoglobin',
    note: 'By the Bell Tower',
    latitude: 33.9737,
    longitude: -117.3281,
    rarity: 'common',
    group: 'hemoglobin',
    quiz: {
      question: 'What does hemoglobin carry around the body?',
      options: ['Oxygen', 'Glucose', 'Calcium', 'Insulin'],
      answerIndex: 0,
    },
  },
  {
    name: 'Actin–Myosin',
    note: 'Near Rivera Library',
    latitude: 33.9742,
    longitude: -117.3262,
    rarity: 'uncommon',
    group: 'actin-myosin',
    quiz: {
      question: 'Actin and myosin slide past each other to do what?',
      options: ['Digest food', 'Contract muscle', 'Copy DNA', 'Fight infection'],
      answerIndex: 1,
    },
  },
  {
    name: 'Receptors',
    note: 'Outside the Student Rec Center',
    latitude: 33.9757,
    longitude: -117.3269,
    rarity: 'rare',
    group: 'receptors',
    quiz: {
      question: 'A receptor on a cell surface mostly…',
      options: ['Stores fat', 'Detects signals from outside', 'Makes ATP', 'Holds the nucleus'],
      answerIndex: 1,
    },
  },
  { name: 'Hemoglobin', note: 'Botanic Gardens path', latitude: 33.965, longitude: -117.3225, rarity: 'common', group: 'hemoglobin' },
  { name: 'Actin–Myosin', note: 'Highlander Union lawn', latitude: 33.9744, longitude: -117.3286, rarity: 'rare', group: 'actin-myosin' },
  { name: 'Receptors', note: 'Science library steps', latitude: 33.9731, longitude: -117.3299, rarity: 'legendary', group: 'receptors' },
  { name: 'Mystery protein', note: 'No model yet: add one in /admin', latitude: 33.9722, longitude: -117.3268, rarity: 'common' },
];

type LibraryFile = { file: string; group: string; style: 'sphere' | 'ribbon'; lod: 0 | 1; codec: string; hq: boolean };

/** <group>-<sphere|ribbon>[-hq][-lod1]-<meshopt|draco>.glb */
function parseName(file: string): LibraryFile | null {
  const match = /^(.+?)-(sphere|ribbon)(-hq)?(-lod1)?-(meshopt|draco)\.glb$/.exec(file);
  if (!match) return null;
  return {
    file,
    group: match[1],
    style: match[2] as 'sphere' | 'ribbon',
    hq: Boolean(match[3]),
    lod: match[4] ? 1 : 0,
    codec: match[5],
  };
}

async function loadLibrary() {
  const files = await readdir(MODELS_DIR).catch(() => [] as string[]);
  return files.map(parseName).filter((entry): entry is LibraryFile => entry !== null && !entry.hq);
}

/** Smallest codec first (Draco), which is what the phones download. */
function pick(library: LibraryFile[], group: string, style: 'sphere' | 'ribbon', lod: 0 | 1) {
  const matches = library.filter((entry) => entry.group === group && entry.style === style && entry.lod === lod);
  return matches.find((entry) => entry.codec === 'draco') ?? matches[0] ?? null;
}

async function upload(entry: LibraryFile | null): Promise<ModelUpload | undefined> {
  if (!entry) return undefined;
  return {
    filename: entry.file,
    mimetype: 'model/gltf-binary',
    data: await readFile(path.join(MODELS_DIR, entry.file)),
  };
}

async function filesFor(library: LibraryFile[], group: string): Promise<ModelFiles> {
  const files: ModelFiles = {};
  files.sphere = await upload(pick(library, group, 'sphere', 0));
  files.sphereLow = await upload(pick(library, group, 'sphere', 1));
  files.ribbon = await upload(pick(library, group, 'ribbon', 0));
  files.ribbonLow = await upload(pick(library, group, 'ribbon', 1));
  for (const key of Object.keys(files) as (keyof ModelFiles)[]) if (!files[key]) delete files[key];
  return files;
}

const PLAYERS = [
  { id: 'seed-player-1', name: 'Maya Patel', catches: 6 },
  { id: 'seed-player-2', name: 'Jordan Lee', catches: 4 },
  { id: 'seed-player-3', name: 'Sam Okafor', catches: 2 },
  { id: 'seed-player-4', name: 'Riley Nguyen', catches: 1 },
];

async function main() {
  const now = new Date();
  await db
    .insert(user)
    .values({ id: SEED_USER, name: 'Seed', email: 'seed@ucr.edu', emailVerified: true, createdAt: now, updatedAt: now })
    .onConflictDoNothing();
  const admin = await devUser('admin');
  await devUser('student');

  // Replace anything an earlier run made.
  const old = await db.select({ id: spawn.id }).from(spawn).where(eq(spawn.createdBy, SEED_USER));
  for (const row of old) await deleteSpawn(row.id);
  await db.delete(accessCode).where(eq(accessCode.code, DEMO_CODE));
  await db.insert(accessCode).values({
    id: crypto.randomUUID(),
    code: DEMO_CODE,
    label: 'Demo class',
    expiresAt: new Date(Date.now() + 90 * 86_400_000),
    createdBy: admin.id,
    createdAt: now,
  });

  const library = await loadLibrary();
  if (!library.length) console.warn(`No models found in ${MODELS_DIR}: proteins will be placed without models.`);

  const created: { id: string; rarity: Rarity }[] = [];
  for (const plan of PLANS) {
    const row = await createSpawn({
      name: plan.name,
      summary: plan.note,
      latitude: plan.latitude,
      longitude: plan.longitude,
      radiusMeters: 40,
      expiresAt: null,
      createdBy: SEED_USER,
      rarity: plan.rarity,
      quiz: plan.quiz,
      files: plan.group ? await filesFor(library, plan.group) : {},
    });
    created.push({ id: row.id, rarity: plan.rarity });
    const styles = row.styles.map((s) => `${s.style}${s.lowUrl ? '+LOD' : ''}`).join(' ') || 'no model';
    console.log(`  ${plan.name.padEnd(14)} ${plan.rarity.padEnd(9)} ${styles}`);
  }

  // Fake players with some catches, so the collection and leaderboard are not empty.
  for (const player of PLAYERS) {
    await db
      .insert(user)
      .values({
        id: player.id,
        name: player.name,
        email: `${player.id}@ucr.edu`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    await db.delete(capture).where(eq(capture.userId, player.id));
    const rows = created.slice(0, Math.min(player.catches, created.length));
    if (!rows.length) continue;
    const [first] = await db.select().from(spawn).where(inArray(spawn.id, rows.map((r) => r.id)));
    await db.insert(capture).values(
      rows.map((row, index) => ({
        id: crypto.randomUUID(),
        spawnId: row.id,
        userId: player.id,
        latitude: first?.latitude ?? 33.9737,
        longitude: first?.longitude ?? -117.3281,
        xp: rewardFor(row.rarity, false).xp,
        attempts: 1,
        caughtAt: new Date(Date.now() - index * 3_600_000),
      })),
    );
  }

  await updateSettings({ leaderboardEnabled: true });
  console.log(`\nSeeded ${created.length} proteins, ${PLAYERS.length} players, code ${DEMO_CODE}. Leaderboard is on.`);
}

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(error);
    await pool.end();
    process.exit(1);
  });
