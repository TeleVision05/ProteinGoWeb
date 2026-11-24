import { createHmac } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from './db/db';
import { user } from './db/auth-schema';
import { accessCode, appSetting, capture, codeRedemption, exploredCell, spawn, type ModelVariant } from './db/game-schema';
import { buildAchievements, isRarity, levelFor, publicName, rewardFor, streaks, RARITIES, type ProgressStats, type Rarity } from './progress';
import { rateLimited } from './rate-limit';
import { deleteModel, putModel, readBundledModel, readModel } from './storage';

export class GameError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const CODE_PATTERN = /^[A-Z0-9-]{4,32}$/;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const GPS_TOLERANCE_METERS = 25;

export function isAdminEmail(email: string) {
  const allow = (process.env.ADMIN_EMAILS ?? '')
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return allow.includes(email.toLowerCase());
}

export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const earth = 6_371_000;
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(a)));
}

function normalizeCode(raw: string) {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

function generateCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

/** Postgres "duplicate key" (23505). Drizzle wraps the driver error, so look down the `cause` chain too. */
export function isUniqueViolation(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function getAccess(userId: string) {
  const now = new Date();
  const rows = await db
    .select({
      label: accessCode.label,
      expiresAt: accessCode.expiresAt,
      revokedAt: accessCode.revokedAt,
    })
    .from(codeRedemption)
    .innerJoin(accessCode, eq(codeRedemption.codeId, accessCode.id))
    .where(eq(codeRedemption.userId, userId))
    .orderBy(desc(accessCode.expiresAt));

  const current = rows.find((row) => !row.revokedAt && row.expiresAt > now);
  const latest = current ?? rows[0];
  return {
    active: Boolean(current),
    expiresAt: latest?.expiresAt.toISOString() ?? null,
    label: latest?.label ?? null,
  };
}

export async function redeemCode(userId: string, raw: string) {
  const code = normalizeCode(raw);
  if (!CODE_PATTERN.test(code)) throw new GameError('Enter the class code.', 400);
  const now = new Date();
  const [row] = await db.select().from(accessCode).where(eq(accessCode.code, code)).limit(1);
  if (!row || row.revokedAt || row.expiresAt <= now) {
    throw new GameError('That code is expired or not valid.', 400);
  }
  await db
    .insert(codeRedemption)
    .values({
      id: crypto.randomUUID(),
      codeId: row.id,
      userId,
      redeemedAt: now,
    })
    .onConflictDoNothing();
  return getAccess(userId);
}

export async function createCode(input: { label: string; expiresAt: Date; code?: string; createdBy: string }) {
  const label = input.label.trim();
  if (label.length < 2 || label.length > 80) throw new GameError('Give the code a short label.', 400);
  if (Number.isNaN(input.expiresAt.getTime()) || input.expiresAt.getTime() <= Date.now()) {
    throw new GameError('The expiry has to be in the future.', 400);
  }
  const code = input.code?.trim() ? normalizeCode(input.code) : generateCode();
  if (!CODE_PATTERN.test(code)) {
    throw new GameError('Codes are 4–32 letters, numbers, or hyphens.', 400);
  }
  try {
    const [row] = await db
      .insert(accessCode)
      .values({
        id: crypto.randomUUID(),
        code,
        label,
        expiresAt: input.expiresAt,
        createdBy: input.createdBy,
        createdAt: new Date(),
      })
      .returning();
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) throw new GameError('That code already exists.', 409);
    throw error;
  }
}

export async function listCodes() {
  const rows = await db
    .select({
      id: accessCode.id,
      code: accessCode.code,
      label: accessCode.label,
      expiresAt: accessCode.expiresAt,
      revokedAt: accessCode.revokedAt,
      createdAt: accessCode.createdAt,
      redemptions: sql<number>`cast(count(${codeRedemption.id}) as int)`,
    })
    .from(accessCode)
    .leftJoin(codeRedemption, eq(codeRedemption.codeId, accessCode.id))
    .groupBy(accessCode.id)
    .orderBy(desc(accessCode.createdAt));

  const now = Date.now();
  return rows.map((row) => ({
    ...row,
    redemptions: Number(row.redemptions),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    status: row.revokedAt ? 'revoked' : row.expiresAt.getTime() <= now ? 'expired' : 'active',
  }));
}

export async function revokeCode(id: string) {
  const [row] = await db
    .update(accessCode)
    .set({ revokedAt: new Date() })
    .where(and(eq(accessCode.id, id), isNull(accessCode.revokedAt)))
    .returning();
  if (!row) {
    const [existing] = await db.select({ id: accessCode.id }).from(accessCode).where(eq(accessCode.id, id));
    if (!existing) throw new GameError('Code not found.', 404);
  }
  return listCodes();
}

export type ModelUpload = {
  filename: string;
  mimetype: string;
  data: Buffer;
};

export type Style = ModelVariant['style'];
export type Quiz = { question: string; options: string[]; answerIndex: number };
/** Upload slots: the full model and an optional low-detail LOD, per style. */
export type ModelFiles = Partial<Record<'sphere' | 'sphereLow' | 'ribbon' | 'ribbonLow', ModelUpload>>;

const STYLES: Style[] = ['sphere', 'ribbon'];
const GPS_MAX_ACCURACY_METERS = 150;
/** Faster than this over more than MIN_JUMP_METERS between two catches is not walking. */
const MAX_SPEED_MPS = 60;
const MIN_JUMP_METERS = 500;
const CATCH_LIMIT = { count: 20, windowMs: 60_000 };
const WRONG_ANSWER_COOLDOWN_MS = 5_000;

function assertCoordinates(latitude: number, longitude: number) {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new GameError('Those coordinates are not on the map.', 400);
  }
}

function assertRadius(radiusMeters: number) {
  if (!Number.isInteger(radiusMeters) || radiusMeters < 5 || radiusMeters > 250) {
    throw new GameError('Catch radius must be a whole number from 5 to 250 meters.', 400);
  }
}

function assertGlb(file: ModelUpload) {
  const name = file.filename.toLowerCase();
  const magic = file.data.subarray(0, 4).toString('utf8');
  if (!name.endsWith('.glb') || magic !== 'glTF' || file.data.length < 20) {
    throw new GameError('Upload a .glb protein model.', 400);
  }
}

export function parseRarity(value: unknown, fallback: Rarity = 'common'): Rarity {
  if (value == null || value === '') return fallback;
  if (!isRarity(value)) throw new GameError(`Rarity must be one of ${RARITIES.join(', ')}.`, 400);
  return value;
}

/** Accepts a Quiz, its JSON text, or empty (no quiz). Throws on anything half-filled. */
export function parseQuiz(value: unknown): Quiz | null {
  if (value == null || value === '') return null;
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new GameError('The quiz is not valid.', 400);
    }
  }
  if (raw == null) return null;
  const quiz = raw as Partial<Quiz>;
  const question = typeof quiz.question === 'string' ? quiz.question.trim() : '';
  const options = Array.isArray(quiz.options) ? quiz.options.map((option) => String(option).trim()) : [];
  if (question.length < 3 || question.length > 300) throw new GameError('The quiz question needs 3 to 300 characters.', 400);
  if (options.length < 2 || options.length > 4 || options.some((o) => o.length < 1 || o.length > 120)) {
    throw new GameError('A quiz needs 2 to 4 answers, each up to 120 characters.', 400);
  }
  if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) {
    throw new GameError('Quiz answers must all be different.', 400);
  }
  if (!Number.isInteger(quiz.answerIndex) || (quiz.answerIndex as number) < 0 || (quiz.answerIndex as number) >= options.length) {
    throw new GameError('Mark which answer is correct.', 400);
  }
  return { question, options, answerIndex: quiz.answerIndex as number };
}

/** Spawns made before variants existed only have modelKey: that is their single sphere model. */
export function variantsOf(row: typeof spawn.$inferSelect): ModelVariant[] {
  if (row.variants?.length) return row.variants;
  return row.modelKey ? [{ style: 'sphere', lod: 0, key: row.modelKey, filename: row.modelFilename }] : [];
}

function defaultStyleOf(variants: ModelVariant[]): Style | null {
  const styles = STYLES.filter((style) => variants.some((v) => v.style === style && v.lod === 0));
  return styles.includes('sphere') ? 'sphere' : (styles[0] ?? null);
}

function slotsOf(files: ModelFiles): { style: Style; lod: 0 | 1; file: ModelUpload }[] {
  const slots: { style: Style; lod: 0 | 1; file: ModelUpload }[] = [];
  const add = (style: Style, lod: 0 | 1, file?: ModelUpload) => {
    if (file) slots.push({ style, lod, file });
  };
  add('sphere', 0, files.sphere);
  add('sphere', 1, files.sphereLow);
  add('ribbon', 0, files.ribbon);
  add('ribbon', 1, files.ribbonLow);
  return slots;
}

/**
 * Applies new files and removals to a spawn's model variants and writes the files.
 * Every upload gets a fresh key so phones never reuse a cached older model. A new full model drops its old
 * low-detail LOD unless a new one came with it (a stale LOD would show the wrong shape from far away).
 */
async function storeVariants(
  spawnId: string,
  current: ModelVariant[],
  files: ModelFiles,
  removeStyles: Style[] = [],
): Promise<ModelVariant[]> {
  const slots = slotsOf(files);
  for (const slot of slots) assertGlb(slot.file);
  let next = current.filter((variant) => !removeStyles.includes(variant.style));
  const dropped: string[] = current.filter((variant) => removeStyles.includes(variant.style)).map((v) => v.key);
  const stamp = Date.now();
  for (const { style, lod, file } of slots) {
    const key = `proteins/${spawnId}-${style}-${lod}-${stamp}.glb`;
    await putModel(key, file.data, 'model/gltf-binary');
    const lowComesToo = Boolean(files[`${style}Low` as keyof ModelFiles]);
    const replaced = next.filter((v) => v.style === style && (v.lod === lod || (lod === 0 && !lowComesToo)));
    dropped.push(...replaced.map((v) => v.key));
    next = next.filter((v) => !replaced.includes(v));
    next.push({ style, lod, key, filename: file.filename });
  }
  // A low LOD only makes sense next to a full model.
  const orphans = next.filter((v) => v.lod === 1 && !next.some((o) => o.style === v.style && o.lod === 0));
  dropped.push(...orphans.map((v) => v.key));
  next = next.filter((v) => !orphans.includes(v));
  for (const key of new Set(dropped)) {
    if (!next.some((v) => v.key === key)) await deleteModel(key).catch(() => undefined);
  }
  return next;
}

/** The columns the older single-model code reads: the default style's full model. */
function mirrorColumns(variants: ModelVariant[]) {
  const style = defaultStyleOf(variants);
  const main = variants.find((v) => v.style === style && v.lod === 0);
  return { modelKey: main?.key ?? null, modelFilename: main?.filename ?? null };
}

function modelUrl(id: string, variant: ModelVariant) {
  return `/api/models/${id}?style=${variant.style}&lod=${variant.lod}&v=${encodeURIComponent(variant.key)}`;
}

/** With rarity levels switched off, everything counts as common. */
function presentSpawn(row: typeof spawn.$inferSelect, caught: boolean, rarityOn = true) {
  const variants = variantsOf(row);
  const defaultStyle = defaultStyleOf(variants);
  const styles = STYLES.flatMap((style) => {
    const full = variants.find((v) => v.style === style && v.lod === 0);
    if (!full) return [];
    const low = variants.find((v) => v.style === style && v.lod === 1);
    return [{ style, url: modelUrl(row.id, full), lowUrl: low ? modelUrl(row.id, low) : null, filename: full.filename }];
  });
  const main = styles.find((entry) => entry.style === defaultStyle);
  const rarity = rarityOn && isRarity(row.rarity) ? row.rarity : 'common';
  return {
    id: row.id,
    name: row.name,
    summary: row.summary,
    latitude: row.latitude,
    longitude: row.longitude,
    radiusMeters: row.radiusMeters,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    rarity,
    xp: rewardFor(rarity, false).xp,
    hasQuiz: Boolean(row.quiz),
    hasModel: styles.length > 0,
    modelUrl: main?.url ?? null,
    modelFilename: main?.filename ?? null,
    defaultStyle,
    styles,
    caught,
  };
}

function activeSpawnFilter(now: Date) {
  return or(isNull(spawn.expiresAt), gt(spawn.expiresAt, now));
}

const CLOUD_SECRET = process.env.BETTER_AUTH_SECRET || 'proteingo-clouds';
/** How far past the dissolve radius a protein must be before its place is hidden (covers GPS drift and walking between refreshes). */
const CLOUD_HIDE_MARGIN_METERS = 60;

/**
 * Where the cloud's colored hint is centered for a hidden protein: the real spot nudged by a fixed random amount
 * (20% to 50% of the hint radius, in a random direction), so the middle of the glow is not the protein. The nudge
 * comes from a keyed hash, so it never changes between refreshes (no averaging it away) and players cannot work it out.
 */
export function cloudHintCenter(id: string, latitude: number, longitude: number, hintRadius: number) {
  const digest = createHmac('sha256', CLOUD_SECRET).update(id).digest();
  const angle = (digest.readUInt16BE(0) / 65535) * 2 * Math.PI;
  const meters = (0.2 + 0.3 * (digest.readUInt16BE(2) / 65535)) * hintRadius;
  const metersPerDegreeLng = 111_320 * Math.max(0.01, Math.cos((latitude * Math.PI) / 180));
  return {
    latitude: latitude + (Math.cos(angle) * meters) / 110_574,
    longitude: longitude + (Math.sin(angle) * meters) / metersPerDegreeLng,
  };
}

/**
 * The explored grid. Squares are 25 m, counted east and north from a fixed point on campus (the app's map must use
 * the same point and size; it reads them from GET /api/explored). Squares more than 3 km out are ignored.
 */
export const EXPLORE = { originLat: 33.9737, originLng: -117.3281, cellMeters: 25, maxCell: 120 } as const;

export function exploreCellOf(latitude: number, longitude: number) {
  const east = (longitude - EXPLORE.originLng) * 111_320 * Math.cos((EXPLORE.originLat * Math.PI) / 180);
  const north = (latitude - EXPLORE.originLat) * 110_574;
  const cx = Math.floor(east / EXPLORE.cellMeters);
  const cy = Math.floor(north / EXPLORE.cellMeters);
  if (Math.abs(cx) > EXPLORE.maxCell || Math.abs(cy) > EXPLORE.maxCell) return null;
  return { cx, cy };
}

export function exploreCellCenter(cx: number, cy: number) {
  const east = (cx + 0.5) * EXPLORE.cellMeters;
  const north = (cy + 0.5) * EXPLORE.cellMeters;
  return {
    latitude: EXPLORE.originLat + north / 110_574,
    longitude: EXPLORE.originLng + east / (111_320 * Math.cos((EXPLORE.originLat * Math.PI) / 180)),
  };
}

export async function getExplored(userId: string) {
  const rows = await db.select({ cx: exploredCell.cx, cy: exploredCell.cy }).from(exploredCell).where(eq(exploredCell.userId, userId));
  return {
    originLat: EXPLORE.originLat,
    originLng: EXPLORE.originLng,
    cellMeters: EXPLORE.cellMeters,
    maxCell: EXPLORE.maxCell,
    cells: rows.map((row) => [row.cx, row.cy] as [number, number]),
  };
}

/** Remember that the player has been through this square. Only while cloud cover is on; returns whether it was new. */
export async function markExplored(userId: string, latitude: unknown, longitude: unknown) {
  if (
    typeof latitude !== 'number' || typeof longitude !== 'number' ||
    !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 || Math.abs(longitude) > 180
  ) {
    throw new GameError('A position is needed.', 400);
  }
  if (rateLimited(`explore:${userId}`, 60, 60_000)) throw new GameError('Slow down a little.', 429);
  if (!(await getSettings()).cloudsEnabled) return { added: false };
  const cell = exploreCellOf(latitude, longitude);
  if (!cell) return { added: false };
  const inserted = await db
    .insert(exploredCell)
    .values({ userId, cx: cell.cx, cy: cell.cy })
    .onConflictDoNothing()
    .returning({ cx: exploredCell.cx });
  return { added: inserted.length > 0 };
}

/** Is there a square the player has explored whose center is within `radius` meters of this point? */
function exploredNear(cells: Set<string>, latitude: number, longitude: number, radius: number) {
  const home = exploreCellOf(latitude, longitude);
  if (!home || cells.size === 0) return false;
  const span = Math.ceil(radius / EXPLORE.cellMeters) + 1;
  for (let dx = -span; dx <= span; dx++) {
    for (let dy = -span; dy <= span; dy++) {
      if (!cells.has(`${home.cx + dx},${home.cy + dy}`)) continue;
      const center = exploreCellCenter(home.cx + dx, home.cy + dy);
      if (distanceMeters(center.latitude, center.longitude, latitude, longitude) <= radius) return true;
    }
  }
  return false;
}

/**
 * The spawns a player sees. With dynamic cloud cover on, a protein is only shown for real when the player is within the
 * dissolve radius of it now, or has explored the ground it stands on (the fog stays cleared there). Any other protein
 * is sent with a nudged location and no summary (hidden: true), so its real position is not in the response at all.
 * The game's own rules still use the real position on the server.
 */
export async function listPlaySpawns(userId: string, here?: { latitude: number; longitude: number } | null) {
  const now = new Date();
  const rows = await db.select().from(spawn).where(activeSpawnFilter(now)).orderBy(spawn.name);
  const caught = await db.select({ spawnId: capture.spawnId }).from(capture).where(eq(capture.userId, userId));
  const caughtIds = new Set(caught.map((row) => row.spawnId));
  const settings = await getSettings();
  const hide = settings.cloudsEnabled && !catchAnywhere();
  const explored = hide ? new Set((await getExplored(userId)).cells.map(([cx, cy]) => `${cx},${cy}`)) : new Set<string>();
  return rows.map((row) => {
    const view = presentSpawn(row, caughtIds.has(row.id), settings.rarityEnabled);
    if (!hide) return { ...view, hidden: false };
    const near =
      here != null &&
      distanceMeters(here.latitude, here.longitude, row.latitude, row.longitude) <=
        settings.cloudDissolveRadius + CLOUD_HIDE_MARGIN_METERS;
    if (near || exploredNear(explored, row.latitude, row.longitude, settings.cloudDissolveRadius)) {
      return { ...view, hidden: false };
    }
    const center = cloudHintCenter(row.id, row.latitude, row.longitude, settings.cloudHintRadius);
    return { ...view, ...center, summary: null, hidden: true };
  });
}

export async function listAdminSpawns() {
  const rows = await db.select().from(spawn).orderBy(desc(spawn.createdAt));
  const counts = await db
    .select({ spawnId: capture.spawnId, count: sql<number>`cast(count(*) as int)` })
    .from(capture)
    .groupBy(capture.spawnId);
  const byId = new Map(counts.map((row) => [row.spawnId, Number(row.count)]));
  return rows.map((row) => ({
    ...presentSpawn(row, false),
    quiz: row.quiz ?? null,
    catchCount: byId.get(row.id) ?? 0,
  }));
}

export async function createSpawn(input: {
  name: string;
  summary: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  expiresAt: Date | null;
  createdBy: string;
  rarity?: unknown;
  quiz?: unknown;
  files?: ModelFiles;
  /** Older callers: a single model, stored as the sphere. */
  file?: ModelUpload | null;
}) {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) throw new GameError('Name the protein.', 400);
  assertCoordinates(input.latitude, input.longitude);
  assertRadius(input.radiusMeters);
  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
    throw new GameError('The spawn expiry has to be in the future.', 400);
  }
  const rarity = parseRarity(input.rarity);
  const quiz = parseQuiz(input.quiz);
  const id = crypto.randomUUID();
  const files: ModelFiles = { ...input.files };
  if (input.file && !files.sphere) files.sphere = input.file;
  const variants = await storeVariants(id, [], files);
  const [row] = await db
    .insert(spawn)
    .values({
      id,
      name,
      summary: input.summary.trim() || null,
      latitude: input.latitude,
      longitude: input.longitude,
      radiusMeters: input.radiusMeters,
      rarity,
      quiz,
      variants,
      ...mirrorColumns(variants),
      expiresAt: input.expiresAt,
      createdBy: input.createdBy,
      createdAt: new Date(),
    })
    .returning();
  return presentSpawn(row, false);
}

export async function updateSpawn(
  id: string,
  input: {
    name?: string;
    summary?: string;
    latitude?: number;
    longitude?: number;
    radiusMeters?: number;
    expiresAt?: Date | null;
    rarity?: unknown;
    /** undefined keeps the quiz; '' or null clears it. */
    quiz?: unknown;
    files?: ModelFiles;
    file?: ModelUpload | null;
    removeStyles?: Style[];
  },
) {
  const [existing] = await db.select().from(spawn).where(eq(spawn.id, id));
  if (!existing) throw new GameError('Spawn not found.', 404);
  const name = input.name?.trim() ?? existing.name;
  if (name.length < 2 || name.length > 80) throw new GameError('Name the protein.', 400);
  const latitude = input.latitude ?? existing.latitude;
  const longitude = input.longitude ?? existing.longitude;
  const radiusMeters = input.radiusMeters ?? existing.radiusMeters;
  assertCoordinates(latitude, longitude);
  assertRadius(radiusMeters);
  const rarity = input.rarity === undefined ? parseRarity(existing.rarity) : parseRarity(input.rarity);
  const quiz = input.quiz === undefined ? (existing.quiz ?? null) : parseQuiz(input.quiz);
  const files: ModelFiles = { ...input.files };
  if (input.file && !files.sphere) files.sphere = input.file;
  const hasChange = slotsOf(files).length > 0 || (input.removeStyles?.length ?? 0) > 0;
  const variants = hasChange
    ? await storeVariants(id, variantsOf(existing), files, input.removeStyles ?? [])
    : variantsOf(existing);
  const [row] = await db
    .update(spawn)
    .set({
      name,
      summary: input.summary !== undefined ? input.summary.trim() || null : existing.summary,
      latitude,
      longitude,
      radiusMeters,
      rarity,
      quiz,
      expiresAt: input.expiresAt !== undefined ? input.expiresAt : existing.expiresAt,
      ...(hasChange ? { variants, ...mirrorColumns(variants) } : {}),
    })
    .where(eq(spawn.id, id))
    .returning();
  return presentSpawn(row, false);
}

export async function deleteSpawn(id: string) {
  const [existing] = await db.select().from(spawn).where(eq(spawn.id, id));
  if (!existing) throw new GameError('Spawn not found.', 404);
  await db.delete(spawn).where(eq(spawn.id, id));
  for (const variant of variantsOf(existing)) await deleteModel(variant.key).catch(() => undefined);
}

/** Random points in a circle, spaced at least `spacing` meters apart where it can manage. */
export function scatterPoints(
  center: { latitude: number; longitude: number },
  areaRadiusMeters: number,
  count: number,
  spacing: number,
  random: () => number = Math.random,
) {
  const points: { latitude: number; longitude: number }[] = [];
  const metersPerDegree = 111_320;
  for (let i = 0; i < count; i++) {
    let best: { latitude: number; longitude: number } | null = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      const radius = areaRadiusMeters * Math.sqrt(random());
      const angle = random() * Math.PI * 2;
      const candidate = {
        latitude: center.latitude + (radius * Math.cos(angle)) / metersPerDegree,
        longitude:
          center.longitude +
          (radius * Math.sin(angle)) / (metersPerDegree * Math.cos((center.latitude * Math.PI) / 180)),
      };
      best = candidate;
      if (points.every((p) => distanceMeters(p.latitude, p.longitude, candidate.latitude, candidate.longitude) >= spacing)) break;
    }
    if (best) points.push(best);
  }
  return points;
}

/** Makes `count` copies of a spawn at random spots in an area. Each copy gets its own copy of the model files. */
export async function scatterSpawns(input: {
  templateId: string;
  count: number;
  centerLatitude: number;
  centerLongitude: number;
  areaRadiusMeters: number;
  namePrefix?: string;
  createdBy: string;
}) {
  const [template] = await db.select().from(spawn).where(eq(spawn.id, input.templateId));
  if (!template) throw new GameError('Pick a protein to copy.', 404);
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > 50) {
    throw new GameError('Make between 1 and 50 copies at a time.', 400);
  }
  if (!Number.isFinite(input.areaRadiusMeters) || input.areaRadiusMeters < 20 || input.areaRadiusMeters > 2000) {
    throw new GameError('The area radius has to be 20 to 2000 meters.', 400);
  }
  assertCoordinates(input.centerLatitude, input.centerLongitude);
  const points = scatterPoints(
    { latitude: input.centerLatitude, longitude: input.centerLongitude },
    input.areaRadiusMeters,
    input.count,
    template.radiusMeters * 2,
  );
  const sources = variantsOf(template);
  const buffers = new Map<string, Buffer>();
  for (const variant of sources) {
    const body = (await readModel(variant.key)) ?? (await readBundledModel(variant.filename));
    if (body) buffers.set(variant.key, body);
  }
  const prefix = input.namePrefix?.trim();
  const made: ReturnType<typeof presentSpawn>[] = [];
  for (const [index, point] of points.entries()) {
    const id = crypto.randomUUID();
    const stamp = Date.now() + index;
    const variants: ModelVariant[] = [];
    for (const variant of sources) {
      const body = buffers.get(variant.key);
      if (!body) continue;
      const key = `proteins/${id}-${variant.style}-${variant.lod}-${stamp}.glb`;
      await putModel(key, body, 'model/gltf-binary');
      variants.push({ ...variant, key });
    }
    const [row] = await db
      .insert(spawn)
      .values({
        id,
        name: prefix ? `${prefix} ${index + 1}` : template.name,
        summary: template.summary,
        latitude: point.latitude,
        longitude: point.longitude,
        radiusMeters: template.radiusMeters,
        rarity: template.rarity,
        quiz: template.quiz,
        variants,
        ...mirrorColumns(variants),
        expiresAt: template.expiresAt,
        createdBy: input.createdBy,
        createdAt: new Date(),
      })
      .returning();
    made.push(presentSpawn(row, false));
  }
  return made;
}

/** Where players have caught things: points for an admin heatmap. */
export async function captureHeatmap() {
  const rows = await db.select({ latitude: capture.latitude, longitude: capture.longitude }).from(capture);
  return { points: rows.map((row) => ({ ...row, weight: 1 })) };
}

// ---- Settings ---------------------------------------------------------------------------------

/** Dynamic cloud cover numbers: the allowed range and the default for each (meters, or percent for transparency). */
export const CLOUD_LIMITS = {
  dissolveRadius: { min: 20, max: 1000, fallback: 120 },
  hintRadius: { min: 50, max: 3000, fallback: 350 },
  transparency: { min: 0, max: 90, fallback: 15 },
} as const;

function numberSetting(raw: string | undefined, limits: { min: number; max: number; fallback: number }) {
  const value = Number(raw);
  if (raw === undefined || !Number.isFinite(value)) return limits.fallback;
  return Math.min(limits.max, Math.max(limits.min, Math.round(value)));
}

export async function getSettings() {
  const rows = await db.select().from(appSetting);
  const map = new Map(rows.map((row) => [row.key, row.value]));
  return {
    leaderboardEnabled: map.get('leaderboard_enabled') === 'true',
    // On unless an admin turned it off.
    rarityEnabled: map.get('rarity_enabled') !== 'false',
    // Dynamic cloud cover: off unless an admin turned it on.
    cloudsEnabled: map.get('clouds_enabled') === 'true',
    cloudDissolveRadius: numberSetting(map.get('cloud_dissolve_radius'), CLOUD_LIMITS.dissolveRadius),
    cloudHintRadius: numberSetting(map.get('cloud_hint_radius'), CLOUD_LIMITS.hintRadius),
    cloudTransparency: numberSetting(map.get('cloud_transparency'), CLOUD_LIMITS.transparency),
  };
}

async function saveSwitch(key: string, label: string, value: unknown) {
  if (value === undefined) return;
  if (typeof value !== 'boolean') throw new GameError(`${label} must be true or false.`, 400);
  await db
    .insert(appSetting)
    .values({ key, value: String(value) })
    .onConflictDoUpdate({ target: appSetting.key, set: { value: String(value) } });
}

async function saveNumber(
  key: string,
  label: string,
  value: unknown,
  limits: { min: number; max: number; fallback: number },
) {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < limits.min || value > limits.max) {
    throw new GameError(`${label} must be a number from ${limits.min} to ${limits.max}.`, 400);
  }
  const text = String(Math.round(value));
  await db
    .insert(appSetting)
    .values({ key, value: text })
    .onConflictDoUpdate({ target: appSetting.key, set: { value: text } });
}

export type SettingsInput = {
  leaderboardEnabled?: boolean;
  rarityEnabled?: boolean;
  cloudsEnabled?: boolean;
  cloudDissolveRadius?: number;
  cloudHintRadius?: number;
  cloudTransparency?: number;
};

export async function updateSettings(input: SettingsInput) {
  await saveSwitch('leaderboard_enabled', 'leaderboardEnabled', input.leaderboardEnabled);
  await saveSwitch('rarity_enabled', 'rarityEnabled', input.rarityEnabled);
  await saveSwitch('clouds_enabled', 'cloudsEnabled', input.cloudsEnabled);
  await saveNumber('cloud_dissolve_radius', 'Dissolve radius', input.cloudDissolveRadius, CLOUD_LIMITS.dissolveRadius);
  await saveNumber('cloud_hint_radius', 'Hint radius', input.cloudHintRadius, CLOUD_LIMITS.hintRadius);
  await saveNumber('cloud_transparency', 'Cloud transparency', input.cloudTransparency, CLOUD_LIMITS.transparency);
  return getSettings();
}

// ---- Progress, collection, leaderboard --------------------------------------------------------

export async function getProgress(userId: string) {
  const now = new Date();
  const rows = await db
    .select({
      spawnId: capture.spawnId,
      xp: capture.xp,
      attempts: capture.attempts,
      caughtAt: capture.caughtAt,
      rarity: spawn.rarity,
      hasQuiz: sql<boolean>`${spawn.quiz} is not null`,
      expiresAt: spawn.expiresAt,
    })
    .from(capture)
    .innerJoin(spawn, eq(capture.spawnId, spawn.id))
    .where(eq(capture.userId, userId));
  const [{ total }] = await db
    .select({ total: sql<number>`cast(count(*) as int)` })
    .from(spawn)
    .where(activeSpawnFilter(now));
  const byRarity: Record<Rarity, number> = { common: 0, uncommon: 0, rare: 0, legendary: 0 };
  const { rarityEnabled } = await getSettings();
  for (const row of rows) byRarity[rarityEnabled && isRarity(row.rarity) ? row.rarity : 'common']++;
  const run = streaks(rows.map((row) => row.caughtAt), now);
  const stats: ProgressStats = {
    caught: rows.length,
    activeCaught: rows.filter((row) => !row.expiresAt || row.expiresAt > now).length,
    totalSpawns: Number(total),
    streak: run.current,
    bestStreak: run.best,
    byRarity,
    firstTryQuizzes: rows.filter((row) => row.hasQuiz && row.attempts === 1).length,
  };
  const xp = rows.reduce((sum, row) => sum + row.xp, 0);
  const rank = rows.length ? await rankOf(xp) : null;
  return {
    xp,
    ...levelFor(xp),
    caught: stats.caught,
    totalSpawns: stats.totalSpawns,
    streak: stats.streak,
    bestStreak: stats.bestStreak,
    rank,
    achievements: buildAchievements(stats),
  };
}

async function rankOf(xp: number) {
  const totals = await db
    .select({ total: sql<number>`cast(sum(${capture.xp}) as int)` })
    .from(capture)
    .groupBy(capture.userId);
  return 1 + totals.filter((row) => Number(row.total) > xp).length;
}

export async function getCollection(userId: string) {
  const now = new Date();
  const mine = await db.select().from(capture).where(eq(capture.userId, userId));
  const caughtAt = new Map(mine.map((row) => [row.spawnId, row.caughtAt]));
  const rows = await db
    .select()
    .from(spawn)
    .where(
      caughtAt.size ? or(activeSpawnFilter(now), inArray(spawn.id, [...caughtAt.keys()])) : activeSpawnFilter(now),
    )
    .orderBy(spawn.name);
  const { rarityEnabled } = await getSettings();
  const items = rows.map((row) => {
    const view = presentSpawn(row, caughtAt.has(row.id), rarityEnabled);
    return {
      id: view.id,
      name: view.name,
      summary: view.summary,
      rarity: view.rarity,
      xp: view.xp,
      caught: view.caught,
      caughtAt: caughtAt.get(row.id)?.toISOString() ?? null,
      hasModel: view.hasModel,
      expired: Boolean(row.expiresAt && row.expiresAt <= now),
      styles: view.styles,
      defaultStyle: view.defaultStyle,
    };
  });
  return { items, progress: await getProgress(userId) };
}

export async function getLeaderboard(userId: string) {
  const settings = await getSettings();
  if (!settings.leaderboardEnabled) return { enabled: false, entries: [], me: null };
  const totals = await db
    .select({
      userId: capture.userId,
      name: user.name,
      xp: sql<number>`cast(sum(${capture.xp}) as int)`,
      caught: sql<number>`cast(count(*) as int)`,
    })
    .from(capture)
    .innerJoin(user, eq(capture.userId, user.id))
    .groupBy(capture.userId, user.name)
    .orderBy(desc(sql`sum(${capture.xp})`), sql`min(${capture.caughtAt})`);
  const ranked = totals.map((row, index) => ({
    rank: index + 1,
    name: publicName(row.name),
    xp: Number(row.xp),
    level: levelFor(Number(row.xp)).level,
    caught: Number(row.caught),
    isMe: row.userId === userId,
  }));
  const me = ranked.find((row) => row.isMe);
  return {
    enabled: true,
    entries: ranked.slice(0, 25),
    me: me ? { rank: me.rank, xp: me.xp, level: me.level, caught: me.caught } : null,
  };
}

// ---- Catching ---------------------------------------------------------------------------------

/** TEMPORARY test switch: when CATCH_ANYWHERE=true, catching needs no location and no distance check. */
export function catchAnywhere() {
  return process.env.CATCH_ANYWHERE === 'true';
}

const wrongAnswers = new Map<string, { count: number; at: number }>();

/** The question for a spawn, without the answer. */
export async function getChallenge(spawnId: string) {
  const [row] = await db
    .select()
    .from(spawn)
    .where(and(eq(spawn.id, spawnId), activeSpawnFilter(new Date())));
  if (!row) throw new GameError('This protein is no longer on campus.', 404);
  if (!row.quiz) throw new GameError('This protein has no question.', 404);
  return { question: row.quiz.question, options: row.quiz.options };
}

export async function catchSpawn(input: {
  userId: string;
  spawnId: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  answer?: number;
}) {
  const anywhere = catchAnywhere();
  if (!anywhere) assertCoordinates(input.latitude as number, input.longitude as number);
  if (rateLimited(`catch:${input.userId}`, CATCH_LIMIT.count, CATCH_LIMIT.windowMs)) {
    throw new GameError('Too many catch attempts. Wait a minute and try again.', 429);
  }
  const now = new Date();
  const [row] = await db
    .select()
    .from(spawn)
    .where(and(eq(spawn.id, input.spawnId), activeSpawnFilter(now)));
  if (!row) throw new GameError('This protein is no longer on campus.', 404);
  const [already] = await db
    .select({ id: capture.id })
    .from(capture)
    .where(and(eq(capture.spawnId, row.id), eq(capture.userId, input.userId)));
  if (already) {
    return { caught: true, already: true, xp: 0, bonus: 0, leveledUp: false, progress: await getProgress(input.userId) };
  }
  const latitude = input.latitude ?? row.latitude;
  const longitude = input.longitude ?? row.longitude;
  if (!anywhere) {
    if (input.accuracy != null && input.accuracy > GPS_MAX_ACCURACY_METERS) {
      throw new GameError(
        `Your GPS is too rough (±${Math.round(input.accuracy)} m). Move into the open and try again.`,
        400,
      );
    }
    const away = distanceMeters(latitude, longitude, row.latitude, row.longitude);
    if (away > row.radiusMeters + GPS_TOLERANCE_METERS) {
      throw new GameError(
        `You are ${Math.round(away)} m away. Get within ${row.radiusMeters} m to catch it.`,
        400,
      );
    }
    // Anti-cheat: a spoofed location tends to teleport. Walking, biking and driving between campus spots are fine.
    const [last] = await db
      .select()
      .from(capture)
      .where(eq(capture.userId, input.userId))
      .orderBy(desc(capture.caughtAt))
      .limit(1);
    if (last) {
      const jump = distanceMeters(last.latitude, last.longitude, latitude, longitude);
      const seconds = Math.max(1, (now.getTime() - last.caughtAt.getTime()) / 1000);
      if (jump > MIN_JUMP_METERS && jump / seconds > MAX_SPEED_MPS) {
        throw new GameError('Your location jumped too far, too fast. Try again in a moment.', 400);
      }
    }
  }

  let attempts = 1;
  if (row.quiz) {
    if (!Number.isInteger(input.answer)) throw new GameError('Answer the question to catch this protein.', 400);
    const key = `${input.userId}:${row.id}`;
    const wrong = wrongAnswers.get(key);
    if (wrong && now.getTime() - wrong.at < WRONG_ANSWER_COOLDOWN_MS) {
      throw new GameError('Take a moment, then try again.', 429);
    }
    if (input.answer !== row.quiz.answerIndex) {
      wrongAnswers.set(key, { count: (wrong?.count ?? 0) + 1, at: now.getTime() });
      throw new GameError('Not quite. Give it another go.', 422);
    }
    attempts = (wrong?.count ?? 0) + 1;
    wrongAnswers.delete(key);
  }

  const { rarityEnabled } = await getSettings();
  const { xp: base, bonus } = rewardFor(rarityEnabled ? row.rarity : 'common', Boolean(row.quiz) && attempts === 1);
  const before = await getProgress(input.userId);
  const inserted = await db
    .insert(capture)
    .values({
      id: crypto.randomUUID(),
      spawnId: row.id,
      userId: input.userId,
      latitude,
      longitude,
      xp: base + bonus,
      attempts,
      caughtAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: capture.id });
  if (!inserted.length) {
    return { caught: true, already: true, xp: 0, bonus: 0, leveledUp: false, progress: before };
  }
  const progress = await getProgress(input.userId);
  return {
    caught: true,
    already: false,
    xp: base,
    bonus,
    leveledUp: progress.level > before.level,
    progress,
  };
}

export async function readSpawnModel(id: string, style?: string, lod?: string) {
  const [row] = await db.select().from(spawn).where(eq(spawn.id, id));
  const variants = row ? variantsOf(row) : [];
  const wantedStyle = style && (STYLES as string[]).includes(style) ? style : defaultStyleOf(variants);
  const wantedLod = lod === '1' ? 1 : 0;
  const variant =
    variants.find((v) => v.style === wantedStyle && v.lod === wantedLod) ??
    variants.find((v) => v.style === wantedStyle && v.lod === 0);
  if (!variant) throw new GameError('This protein has no model yet.', 404);
  const body = (await readModel(variant.key)) ?? (await readBundledModel(variant.filename));
  if (!body) throw new GameError('The model file is missing.', 404);
  return { filename: variant.filename ?? 'protein.glb', body };
}
