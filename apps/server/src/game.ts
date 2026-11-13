import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { db } from './db/db';
import { accessCode, capture, codeRedemption, spawn } from './db/game-schema';
import { deleteModel, putModel, readModel } from './storage';

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

function isUniqueViolation(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === '23505';
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

function assertCoordinates(latitude: number, longitude: number) {
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
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

async function storeModel(spawnId: string, file: ModelUpload | null, previousKey: string | null) {
  if (!file) return { modelKey: previousKey, modelFilename: null as string | null };
  assertGlb(file);
  // A new key per upload: the model URL carries it, so phones never reuse a cached older model.
  const key = `proteins/${spawnId}-${Date.now()}.glb`;
  await putModel(key, file.data, 'model/gltf-binary');
  if (previousKey && previousKey !== key) await deleteModel(previousKey).catch(() => undefined);
  return { modelKey: key, modelFilename: file.filename };
}

function presentSpawn(row: typeof spawn.$inferSelect, caught: boolean) {
  return {
    id: row.id,
    name: row.name,
    summary: row.summary,
    latitude: row.latitude,
    longitude: row.longitude,
    radiusMeters: row.radiusMeters,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    hasModel: Boolean(row.modelKey),
    modelUrl: row.modelKey ? `/api/models/${row.id}?v=${encodeURIComponent(row.modelKey)}` : null,
    modelFilename: row.modelFilename,
    caught,
  };
}

function activeSpawnFilter(now: Date) {
  return or(isNull(spawn.expiresAt), gt(spawn.expiresAt, now));
}

export async function listPlaySpawns(userId: string) {
  const now = new Date();
  const rows = await db
    .select()
    .from(spawn)
    .where(activeSpawnFilter(now))
    .orderBy(spawn.name);
  const caught = await db
    .select({ spawnId: capture.spawnId })
    .from(capture)
    .where(eq(capture.userId, userId));
  const caughtIds = new Set(caught.map((row) => row.spawnId));
  return rows.map((row) => presentSpawn(row, caughtIds.has(row.id)));
}

export async function listAdminSpawns() {
  const rows = await db.select().from(spawn).orderBy(desc(spawn.createdAt));
  return rows.map((row) => presentSpawn(row, false));
}

export async function createSpawn(input: {
  name: string;
  summary: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  expiresAt: Date | null;
  createdBy: string;
  file: ModelUpload | null;
}) {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) throw new GameError('Name the protein.', 400);
  assertCoordinates(input.latitude, input.longitude);
  assertRadius(input.radiusMeters);
  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
    throw new GameError('The spawn expiry has to be in the future.', 400);
  }
  const id = crypto.randomUUID();
  const stored = await storeModel(id, input.file, null);
  const [row] = await db
    .insert(spawn)
    .values({
      id,
      name,
      summary: input.summary.trim() || null,
      latitude: input.latitude,
      longitude: input.longitude,
      radiusMeters: input.radiusMeters,
      modelKey: stored.modelKey,
      modelFilename: stored.modelFilename,
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
    file?: ModelUpload | null;
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
  const stored = input.file ? await storeModel(id, input.file, existing.modelKey) : null;
  const [row] = await db
    .update(spawn)
    .set({
      name,
      summary: input.summary !== undefined ? input.summary.trim() || null : existing.summary,
      latitude,
      longitude,
      radiusMeters,
      expiresAt: input.expiresAt !== undefined ? input.expiresAt : existing.expiresAt,
      modelKey: stored?.modelKey ?? existing.modelKey,
      modelFilename: stored?.modelFilename ?? existing.modelFilename,
    })
    .where(eq(spawn.id, id))
    .returning();
  return presentSpawn(row, false);
}

export async function deleteSpawn(id: string) {
  const [existing] = await db.select().from(spawn).where(eq(spawn.id, id));
  if (!existing) throw new GameError('Spawn not found.', 404);
  await db.delete(spawn).where(eq(spawn.id, id));
  if (existing.modelKey) await deleteModel(existing.modelKey).catch(() => undefined);
}

export async function catchSpawn(input: { userId: string; spawnId: string; latitude: number; longitude: number }) {
  assertCoordinates(input.latitude, input.longitude);
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
  if (already) return { caught: true, already: true };
  const away = distanceMeters(input.latitude, input.longitude, row.latitude, row.longitude);
  if (away > row.radiusMeters + GPS_TOLERANCE_METERS) {
    throw new GameError(
      `You are ${Math.round(away)} m away. Get within ${row.radiusMeters} m to catch it.`,
      400,
    );
  }
  await db.insert(capture).values({
    id: crypto.randomUUID(),
    spawnId: row.id,
    userId: input.userId,
    latitude: input.latitude,
    longitude: input.longitude,
    caughtAt: now,
  });
  return { caught: true, already: false };
}

export async function readSpawnModel(id: string) {
  const [row] = await db.select().from(spawn).where(eq(spawn.id, id));
  if (!row?.modelKey) throw new GameError('This protein has no model yet.', 404);
  const body = await readModel(row.modelKey);
  if (!body) throw new GameError('The model file is missing.', 404);
  return { filename: row.modelFilename ?? 'protein.glb', body };
}
