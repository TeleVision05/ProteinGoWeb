// Runs against the dev database (DATABASE_URL). Everything it creates is removed afterwards.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ExecutionContext } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { AdminGuard } from '../auth.guard';
import { user } from '../db/auth-schema';
import { db, pool } from '../db/db';
import { accessCode, assignment, capture, codeRedemption, quizAttempt, spawn } from '../db/game-schema';
import {
  completionCode,
  createAssignment,
  deleteAssignment,
  getRoster,
  listAdminAssignments,
  listMyAssignments,
  newlyCompleted,
  rosterCsv,
} from '../assignments';
import {
  GameError,
  catchSpawn,
  cloudHintCenter,
  createCode,
  createSpawn,
  distanceMeters,
  exploreCellCenter,
  exploreCellOf,
  getChallenge,
  getExplored,
  getCollection,
  getLeaderboard,
  getProgress,
  getSettings,
  listAdminSpawns,
  listPlaySpawns,
  markExplored,
  redeemCode,
  scatterSpawns,
  updateSettings,
  updateSpawn,
} from '../game';
import { resetRateLimits } from '../rate-limit';

const run = crypto.randomUUID().slice(0, 8);
const HERE = { latitude: 33.9737, longitude: -117.3281 };
const NEAR = { latitude: 33.97371, longitude: -117.32811 };
const userIds: string[] = [];
const spawnIds: string[] = [];
const assignmentIds: string[] = [];
let originalLeaderboard = false;
let originalRarity = true;
let previousCatchAnywhere: string | undefined;
let previousAdmins: string | undefined;

async function makeUser(label: string, name = 'Test Player') {
  const id = `test-${run}-${label}`;
  await db.insert(user).values({
    id,
    name,
    email: `${id}@ucr.edu`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  userIds.push(id);
  return id;
}

async function makeSpawn(
  extra: Partial<Parameters<typeof createSpawn>[0]> = {},
  at: { latitude: number; longitude: number } = HERE,
) {
  const row = await createSpawn({
    name: `Test protein ${run}`,
    summary: '',
    ...at,
    radiusMeters: 30,
    expiresAt: null,
    createdBy: userIds[0],
    ...extra,
  });
  spawnIds.push(row.id);
  return row;
}

async function fails(promise: Promise<unknown>, status: number, message?: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof GameError, `expected a GameError, got ${String(error)}`);
    assert.equal(error.status, status, error.message);
    if (message) assert.match(error.message, message);
    return true;
  });
}

before(async () => {
  previousCatchAnywhere = process.env.CATCH_ANYWHERE;
  process.env.CATCH_ANYWHERE = 'false'; // these tests are about the real rules
  const settings = await getSettings();
  originalLeaderboard = settings.leaderboardEnabled;
  originalRarity = settings.rarityEnabled;
  await updateSettings({ rarityEnabled: true }); // the XP tests assume rarity levels are on
  await makeUser('a', 'Alex Rivera');
  await makeUser('b', 'Blair Chen');
  resetRateLimits();
});

after(async () => {
  if (previousCatchAnywhere === undefined) delete process.env.CATCH_ANYWHERE;
  else process.env.CATCH_ANYWHERE = previousCatchAnywhere;
  await updateSettings({ leaderboardEnabled: originalLeaderboard, rarityEnabled: originalRarity });
  if (assignmentIds.length) await db.delete(assignment).where(inArray(assignment.id, assignmentIds));
  if (spawnIds.length) {
    await db.delete(capture).where(inArray(capture.spawnId, spawnIds));
    await db.delete(spawn).where(inArray(spawn.id, spawnIds));
  }
  for (const id of userIds) await db.delete(user).where(eq(user.id, id));
  await pool.end();
});

describe('catching', () => {
  it('refuses a catch from far away', async () => {
    const [a] = userIds;
    const row = await makeSpawn();
    await fails(
      catchSpawn({ userId: a, spawnId: row.id, latitude: 33.99, longitude: -117.35 }),
      400,
      /m away/,
    );
  });

  it('refuses a very rough GPS fix, even when the position is right', async () => {
    const [a] = userIds;
    const row = await makeSpawn();
    await fails(catchSpawn({ userId: a, spawnId: row.id, ...NEAR, accuracy: 400 }), 400, /too rough/);
  });

  it('refuses a missing location', async () => {
    const [a] = userIds;
    const row = await makeSpawn();
    await fails(catchSpawn({ userId: a, spawnId: row.id }), 400);
  });

  it('catches inside the radius, awards rarity XP and ignores repeats', async () => {
    const userId = await makeUser('catcher');
    const row = await makeSpawn({ rarity: 'rare' });
    const first = await catchSpawn({ userId, spawnId: row.id, ...NEAR, accuracy: 8 });
    assert.equal(first.already, false);
    assert.equal(first.xp, 50);
    assert.equal(first.bonus, 0);
    assert.equal(first.progress.xp, 50);
    assert.equal(first.progress.caught, 1);
    const again = await catchSpawn({ userId, spawnId: row.id, ...NEAR });
    assert.equal(again.already, true);
    assert.equal(again.xp, 0);
    assert.equal((await getProgress(userId)).xp, 50);
  });

  it('flags impossible travel between two catches', async () => {
    const userId = await makeUser('teleporter');
    const one = await makeSpawn();
    const farAway = { latitude: HERE.latitude + 0.05, longitude: HERE.longitude };
    const two = await makeSpawn({}, farAway);
    await catchSpawn({ userId, spawnId: one.id, ...NEAR });
    await fails(
      catchSpawn({ userId, spawnId: two.id, latitude: farAway.latitude + 0.00001, longitude: farAway.longitude }),
      400,
      /too far, too fast/,
    );
  });

  it('rate limits a flood of attempts', async () => {
    const userId = await makeUser('spammer');
    resetRateLimits();
    for (let i = 0; i < 20; i++) {
      await assert.rejects(catchSpawn({ userId, spawnId: 'nope', ...NEAR }), /no longer/);
    }
    await fails(catchSpawn({ userId, spawnId: 'nope', ...NEAR }), 429, /Too many/);
    resetRateLimits();
  });

  it('does not catch an expired spawn', async () => {
    const [a] = userIds;
    const row = await makeSpawn();
    await db.update(spawn).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(spawn.id, row.id));
    await fails(catchSpawn({ userId: a, spawnId: row.id, ...NEAR }), 404);
  });
});

describe('quiz catches', () => {
  const quiz = { question: 'What carries oxygen in blood?', options: ['Actin', 'Hemoglobin', 'Keratin'], answerIndex: 1 };

  it('hides the answer from the challenge', async () => {
    const row = await makeSpawn({ quiz });
    const challenge = await getChallenge(row.id);
    assert.equal(challenge.question, quiz.question);
    assert.deepEqual(challenge.options, quiz.options);
    assert.ok(!('answerIndex' in challenge));
    const plain = await makeSpawn();
    await fails(getChallenge(plain.id), 404);
  });

  it('needs an answer, rejects a wrong one, and slows retries', async () => {
    const userId = await makeUser('quizzer');
    const row = await makeSpawn({ quiz });
    await fails(catchSpawn({ userId, spawnId: row.id, ...NEAR }), 400, /Answer the question/);
    await fails(catchSpawn({ userId, spawnId: row.id, ...NEAR, answer: 0 }), 422, /Not quite/);
    await fails(catchSpawn({ userId, spawnId: row.id, ...NEAR, answer: 1 }), 429);
    assert.equal((await getProgress(userId)).caught, 0);
  });

  it('adds the first-try bonus for a right answer', async () => {
    const userId = await makeUser('sharp');
    const row = await makeSpawn({ quiz, rarity: 'uncommon' });
    const result = await catchSpawn({ userId, spawnId: row.id, ...NEAR, answer: 1 });
    assert.equal(result.xp, 25);
    assert.equal(result.bonus, 13);
    assert.equal(result.progress.xp, 38);
  });

  it('never shows the quiz answer to players', async () => {
    const row = await makeSpawn({ quiz });
    const [seen] = (await listPlaySpawns(userIds[0])).filter((item) => item.id === row.id);
    assert.equal(seen.hasQuiz, true);
    assert.ok(!('quiz' in seen));
    const [admin] = (await listAdminSpawns()).filter((item) => item.id === row.id);
    assert.deepEqual(admin.quiz, quiz);
  });
});

describe('progress and collection', () => {
  it('lists active and caught proteins with caught state', async () => {
    const userId = await makeUser('collector');
    const mine = await makeSpawn({ rarity: 'legendary' });
    const other = await makeSpawn();
    await catchSpawn({ userId, spawnId: mine.id, ...NEAR });
    const { items, progress } = await getCollection(userId);
    assert.equal(items.find((item) => item.id === mine.id)?.caught, true);
    assert.equal(items.find((item) => item.id === other.id)?.caught, false);
    assert.equal(progress.xp, 100);
    assert.equal(progress.level, 2);
    assert.ok(progress.achievements.find((a) => a.id === 'first-catch')?.unlocked);
    assert.ok(progress.achievements.find((a) => a.id === 'legend')?.unlocked);
    assert.equal(progress.streak, 1);
  });

  it('keeps a caught protein in the collection after it expires', async () => {
    const userId = await makeUser('keeper');
    const row = await makeSpawn();
    await catchSpawn({ userId, spawnId: row.id, ...NEAR });
    await db.update(spawn).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(spawn.id, row.id));
    const { items } = await getCollection(userId);
    assert.equal(items.find((item) => item.id === row.id)?.expired, true);
  });
});

describe('leaderboard setting', () => {
  it('is off until an admin turns it on', async () => {
    await updateSettings({ leaderboardEnabled: false });
    const off = await getLeaderboard(userIds[0]);
    assert.deepEqual(off, { enabled: false, entries: [], me: null });

    const winner = userIds[0];
    const row = await makeSpawn({ rarity: 'legendary' });
    await catchSpawn({ userId: winner, spawnId: row.id, ...NEAR });
    assert.equal((await updateSettings({ leaderboardEnabled: true })).leaderboardEnabled, true);
    const board = await getLeaderboard(winner);
    assert.equal(board.enabled, true);
    const mine = board.entries.find((entry) => entry.isMe);
    assert.ok(mine, 'the player shows on the board');
    assert.equal(mine.name, 'Alex R.');
    assert.equal(board.me?.rank, mine.rank);
    const ranks = board.entries.map((entry) => entry.rank);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  });

  it('rejects a setting that is not a boolean', async () => {
    await assert.rejects(updateSettings({ leaderboardEnabled: 'yes' as unknown as boolean }), GameError);
  });
});

describe('dynamic cloud cover', () => {
  const originalCloud = { enabled: false, dissolve: 120, hint: 350, transparency: 15 };
  const CAMPUS = { latitude: 33.9737, longitude: -117.3281 };

  before(async () => {
    const s = await getSettings();
    originalCloud.enabled = s.cloudsEnabled;
    originalCloud.dissolve = s.cloudDissolveRadius;
    originalCloud.hint = s.cloudHintRadius;
    originalCloud.transparency = s.cloudTransparency;
  });

  after(async () => {
    await updateSettings({
      cloudsEnabled: originalCloud.enabled,
      cloudDissolveRadius: originalCloud.dissolve,
      cloudHintRadius: originalCloud.hint,
      cloudTransparency: originalCloud.transparency,
    });
  });

  it('is off by default and saves each setting', async () => {
    const saved = await updateSettings({ cloudsEnabled: true, cloudDissolveRadius: 150, cloudHintRadius: 400, cloudTransparency: 30 });
    assert.equal(saved.cloudsEnabled, true);
    assert.equal(saved.cloudDissolveRadius, 150);
    assert.equal(saved.cloudHintRadius, 400);
    assert.equal(saved.cloudTransparency, 30);
    assert.equal((await updateSettings({ cloudsEnabled: false })).cloudsEnabled, false);
  });

  it('rejects numbers outside the allowed range', async () => {
    await fails(updateSettings({ cloudDissolveRadius: 5 }), 400, /Dissolve radius/);
    await fails(updateSettings({ cloudHintRadius: 99999 }), 400, /Hint radius/);
    await fails(updateSettings({ cloudTransparency: 100 }), 400, /transparency/i);
    await fails(updateSettings({ cloudDissolveRadius: 'wide' as unknown as number }), 400);
  });

  it('keeps the hint center away from the real spot, the same every time, and inside the hint radius', () => {
    const a = cloudHintCenter('some-spawn', CAMPUS.latitude, CAMPUS.longitude, 400);
    const b = cloudHintCenter('some-spawn', CAMPUS.latitude, CAMPUS.longitude, 400);
    assert.deepEqual(a, b);
    const away = distanceMeters(CAMPUS.latitude, CAMPUS.longitude, a.latitude, a.longitude);
    assert.ok(away >= 0.19 * 400 && away <= 0.51 * 400, `nudged ${away} m`);
    const other = cloudHintCenter('another-spawn', CAMPUS.latitude, CAMPUS.longitude, 400);
    assert.notDeepEqual(a, other);
  });

  it('hides the real place of far proteins and keeps near ones exact', async () => {
    await updateSettings({ cloudsEnabled: true, cloudDissolveRadius: 100, cloudHintRadius: 400 });
    const near = await makeSpawn({ name: 'Cloud near', summary: 'by the fountain' });
    // About 600 m north of the near one.
    const far = await makeSpawn({ name: 'Cloud far', summary: 'behind the library', latitude: near.latitude + 0.0054 });
    const list = await listPlaySpawns(userIds[0], { latitude: near.latitude, longitude: near.longitude });
    const seenNear = list.find((s) => s.id === near.id);
    const seenFar = list.find((s) => s.id === far.id);
    assert.ok(seenNear && seenFar);
    assert.equal(seenNear.hidden, false);
    assert.equal(seenNear.latitude, near.latitude);
    assert.equal(seenNear.summary, 'by the fountain');
    assert.equal(seenFar.hidden, true);
    assert.notEqual(seenFar.latitude, far.latitude);
    assert.equal(seenFar.summary, null);
    // The nudged spot is still near enough that the hint glow covers the real one.
    assert.ok(distanceMeters(far.latitude, far.longitude, seenFar.latitude, seenFar.longitude) <= 0.51 * 400);

    // Without a position everything is hidden; with cloud cover off nothing is.
    const blind = await listPlaySpawns(userIds[0], null);
    assert.ok(blind.filter((s) => [near.id, far.id].includes(s.id)).every((s) => s.hidden));
    await updateSettings({ cloudsEnabled: false });
    const plain = await listPlaySpawns(userIds[0], null);
    assert.ok(plain.filter((s) => [near.id, far.id].includes(s.id)).every((s) => !s.hidden));
  });

  it('maps a position to a 25 m square and back', () => {
    const cell = exploreCellOf(CAMPUS.latitude, CAMPUS.longitude);
    assert.ok(cell);
    const center = exploreCellCenter(cell.cx, cell.cy);
    assert.ok(distanceMeters(CAMPUS.latitude, CAMPUS.longitude, center.latitude, center.longitude) <= 20); // within a square's half-diagonal
    assert.equal(exploreCellOf(center.latitude, center.longitude)?.cx, cell.cx);
    assert.equal(exploreCellOf(CAMPUS.latitude + 0.5, CAMPUS.longitude), null); // far off the grid
  });

  it('remembers squares only while cloud cover is on, once each, and rejects bad positions', async () => {
    await updateSettings({ cloudsEnabled: false });
    assert.deepEqual(await markExplored(userIds[1], CAMPUS.latitude, CAMPUS.longitude), { added: false });
    assert.equal((await getExplored(userIds[1])).cells.length, 0);
    await updateSettings({ cloudsEnabled: true });
    assert.deepEqual(await markExplored(userIds[1], CAMPUS.latitude, CAMPUS.longitude), { added: true });
    assert.deepEqual(await markExplored(userIds[1], CAMPUS.latitude, CAMPUS.longitude), { added: false });
    assert.equal((await getExplored(userIds[1])).cells.length, 1);
    await fails(markExplored(userIds[1], 'north' as unknown as number, 0), 400);
    await fails(markExplored(userIds[1], 500, 0), 400);
  });

  it('keeps a protein visible where the player has been, even after they leave', async () => {
    await updateSettings({ cloudsEnabled: true, cloudDissolveRadius: 100, cloudHintRadius: 400 });
    resetRateLimits();
    const spot = { latitude: CAMPUS.latitude + 0.002, longitude: CAMPUS.longitude };
    const row = await makeSpawn({ name: 'Explored one' }, spot);
    const far = { latitude: spot.latitude + 0.01, longitude: spot.longitude }; // about 1 km away
    const before = (await listPlaySpawns(userIds[0], far)).find((s) => s.id === row.id);
    assert.equal(before?.hidden, true);
    await markExplored(userIds[0], spot.latitude, spot.longitude);
    const after = (await listPlaySpawns(userIds[0], far)).find((s) => s.id === row.id);
    assert.equal(after?.hidden, false);
    assert.equal(after?.latitude, spot.latitude);
    // Someone who never went there still cannot see it.
    const other = (await listPlaySpawns(userIds[1], far)).find((s) => s.id === row.id);
    assert.equal(other?.hidden, true);
  });

  it('does not hide anything in the catch-anywhere test mode', async () => {
    await updateSettings({ cloudsEnabled: true });
    process.env.CATCH_ANYWHERE = 'true';
    try {
      const list = await listPlaySpawns(userIds[0], null);
      assert.ok(list.every((s) => !s.hidden));
    } finally {
      process.env.CATCH_ANYWHERE = 'false';
    }
  });
});

describe('access codes', () => {
  it('says so, instead of failing, when a code already exists', async () => {
    const code = `DUP-${run}`.toUpperCase();
    const first = await createCode({
      label: 'First',
      expiresAt: new Date(Date.now() + 60_000),
      code,
      createdBy: userIds[0],
    });
    try {
      await fails(
        createCode({ label: 'Second', expiresAt: new Date(Date.now() + 60_000), code: code.toLowerCase(), createdBy: userIds[0] }),
        409,
        /already exists/,
      );
    } finally {
      await db.delete(accessCode).where(eq(accessCode.id, first.id));
    }
  });

  it('lets someone redeem the same code twice without an error', async () => {
    const userId = await makeUser('redeemer');
    const code = await createCode({
      label: 'Twice',
      expiresAt: new Date(Date.now() + 60_000),
      createdBy: userIds[0],
    });
    try {
      await redeemCode(userId, code.code);
      assert.equal((await redeemCode(userId, code.code)).active, true);
      const other = await makeUser('redeemer2');
      assert.equal((await redeemCode(other, code.code)).active, true, 'a second person can use the same code');
    } finally {
      await db.delete(codeRedemption).where(eq(codeRedemption.codeId, code.id));
      await db.delete(accessCode).where(eq(accessCode.id, code.id));
    }
  });
});

describe('rarity setting', () => {
  it('treats everything as common while rarity levels are off', async () => {
    const userId = await makeUser('plain');
    const row = await makeSpawn({ rarity: 'legendary' });
    try {
      await updateSettings({ rarityEnabled: false });
      const [seen] = (await listPlaySpawns(userId)).filter((item) => item.id === row.id);
      assert.equal(seen.rarity, 'common');
      assert.equal(seen.xp, 10);
      const [admin] = (await listAdminSpawns()).filter((item) => item.id === row.id);
      assert.equal(admin.rarity, 'legendary', 'admins still see the real rarity');
      const result = await catchSpawn({ userId, spawnId: row.id, ...NEAR });
      assert.equal(result.xp, 10);
    } finally {
      await updateSettings({ rarityEnabled: true });
    }
    const [back] = (await listPlaySpawns(userId)).filter((item) => item.id === row.id);
    assert.equal(back.rarity, 'legendary');
  });
});

describe('spawn management', () => {
  it('validates rarity and quiz on update', async () => {
    const row = await makeSpawn();
    await assert.rejects(updateSpawn(row.id, { rarity: 'mythic' }), /Rarity/);
    await assert.rejects(updateSpawn(row.id, { quiz: { question: 'Which one?', options: ['a'], answerIndex: 0 } }), /2 to 4/);
    const updated = await updateSpawn(row.id, { rarity: 'rare' });
    assert.equal(updated.rarity, 'rare');
  });

  it('can clear a quiz and leaves it alone when not mentioned', async () => {
    const quiz = { question: 'Pick the enzyme', options: ['Amylase', 'Collagen'], answerIndex: 0 };
    const row = await makeSpawn({ quiz });
    assert.equal((await updateSpawn(row.id, { name: `Renamed ${run}` })).hasQuiz, true);
    assert.equal((await updateSpawn(row.id, { quiz: '' })).hasQuiz, false);
  });

  it('stores a model per style and drops a stale LOD when only the full model changes', async () => {
    const glb = (label: string) => ({
      filename: `${label}.glb`,
      mimetype: 'model/gltf-binary',
      data: Buffer.concat([Buffer.from('glTF'), Buffer.alloc(64, label.length)]),
    });
    const row = await makeSpawn({
      files: { sphere: glb('sphere'), sphereLow: glb('sphere-low'), ribbon: glb('ribbon') },
    });
    assert.deepEqual(row.styles.map((s) => s.style), ['sphere', 'ribbon']);
    assert.ok(row.styles[0].lowUrl, 'sphere has a low LOD');
    assert.equal(row.styles[1].lowUrl, null);
    assert.equal(row.defaultStyle, 'sphere');
    assert.match(row.styles[0].url, /style=sphere&lod=0/);

    const replaced = await updateSpawn(row.id, { files: { sphere: glb('sphere-new') } });
    assert.equal(replaced.styles[0].lowUrl, null, 'the old low LOD was dropped with the old model');
    assert.equal(replaced.styles[1].style, 'ribbon');

    const ribbonOnly = await updateSpawn(row.id, { removeStyles: ['sphere'] });
    assert.deepEqual(ribbonOnly.styles.map((s) => s.style), ['ribbon']);
    assert.equal(ribbonOnly.defaultStyle, 'ribbon');
  });

  it('refuses a file that is not a GLB', async () => {
    await assert.rejects(
      makeSpawn({ files: { sphere: { filename: 'x.glb', mimetype: 'x', data: Buffer.from('not a model at all, sorry') } } }),
      /\.glb/,
    );
  });

  it('scatters copies inside the area, keeping rarity and quiz', async () => {
    const template = await makeSpawn({
      rarity: 'rare',
      quiz: { question: 'Which is a ribbon?', options: ['Yes', 'No'], answerIndex: 0 },
    });
    const made = await scatterSpawns({
      templateId: template.id,
      count: 5,
      centerLatitude: HERE.latitude,
      centerLongitude: HERE.longitude,
      areaRadiusMeters: 150,
      namePrefix: `Copy ${run}`,
      createdBy: userIds[0],
    });
    spawnIds.push(...made.map((item) => item.id));
    assert.equal(made.length, 5);
    assert.deepEqual(made.map((item) => item.name), [1, 2, 3, 4, 5].map((n) => `Copy ${run} ${n}`));
    assert.ok(made.every((item) => item.rarity === 'rare' && item.hasQuiz));
    await fails(
      scatterSpawns({
        templateId: template.id,
        count: 500,
        centerLatitude: 0,
        centerLongitude: 0,
        areaRadiusMeters: 100,
        createdBy: userIds[0],
      }),
      400,
    );
  });
});

describe('admin guard', () => {
  const context = (email: string) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ user: { email } }) }) }) as unknown as ExecutionContext;

  before(() => {
    previousAdmins = process.env.ADMIN_EMAILS;
    process.env.ADMIN_EMAILS = `boss-${run}@ucr.edu`;
  });
  after(() => {
    if (previousAdmins === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = previousAdmins;
  });

  it('lets an allowlisted email through, ignoring case', () => {
    assert.equal(new AdminGuard().canActivate(context(`Boss-${run}@UCR.edu`)), true);
  });

  it('blocks everyone else with a 403', () => {
    assert.throws(
      () => new AdminGuard().canActivate(context('student@ucr.edu')),
      (error: unknown) => error instanceof GameError && error.status === 403,
    );
  });
});

/** Lets a wrong answer's cool-down pass without waiting for it. */
async function skipCooldown(userId: string) {
  await db.update(quizAttempt).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(quizAttempt.userId, userId));
}

describe('quiz attempts', () => {
  const quiz = { question: 'What carries oxygen in blood?', options: ['Actin', 'Hemoglobin', 'Keratin'], answerIndex: 1 };

  it('records every answer, and a wrong one means no first-try bonus', async () => {
    const userId = await makeUser('retrier');
    const row = await makeSpawn({ quiz });
    await fails(catchSpawn({ userId, spawnId: row.id, ...NEAR, answer: 2 }), 422);
    // Too soon: turned away before it is recorded as an answer.
    await fails(catchSpawn({ userId, spawnId: row.id, ...NEAR, answer: 1 }), 429);
    let rows = await db.select().from(quizAttempt).where(and(eq(quizAttempt.userId, userId), eq(quizAttempt.spawnId, row.id)));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].correct, false);
    assert.equal(rows[0].answerIndex, 2);

    await skipCooldown(userId);
    const result = await catchSpawn({ userId, spawnId: row.id, ...NEAR, answer: 1 });
    assert.equal(result.bonus, 0);
    rows = await db.select().from(quizAttempt).where(and(eq(quizAttempt.userId, userId), eq(quizAttempt.spawnId, row.id)));
    assert.deepEqual(rows.map((item) => item.correct).sort(), [false, true]);
    const [caught] = await db.select().from(capture).where(and(eq(capture.userId, userId), eq(capture.spawnId, row.id)));
    assert.equal(caught.attempts, 2);
  });

  it('refuses an answer that is not one of the options', async () => {
    const userId = await makeUser('wild');
    const row = await makeSpawn({ quiz });
    await fails(catchSpawn({ userId, spawnId: row.id, ...NEAR, answer: 7 }), 400);
    await fails(catchSpawn({ userId, spawnId: row.id, ...NEAR, answer: -1 }), 400);
  });
});

describe('assignments', () => {
  async function makeAssignment(spawns: string[], extra: { title?: string; dueAt?: Date | null } = {}) {
    const row = await createAssignment({
      title: extra.title ?? `Lab ${run}`,
      dueAt: extra.dueAt ?? null,
      spawnIds: spawns,
      createdBy: userIds[0],
    });
    assignmentIds.push(row.id);
    return row;
  }

  it('checks the title, the proteins and the due date', async () => {
    const one = await makeSpawn();
    const base = { dueAt: null, createdBy: userIds[0] };
    await fails(createAssignment({ ...base, title: 'x', spawnIds: [one.id] }), 400, /title/);
    await fails(createAssignment({ ...base, title: 'Lab', spawnIds: [] }), 400, /at least one/);
    await fails(createAssignment({ ...base, title: 'Lab', spawnIds: [one.id, 'no-such-protein'] }), 400, /no longer exists/);
    await fails(createAssignment({ ...base, title: 'Lab', dueAt: new Date('nope'), spawnIds: [one.id] }), 400, /due date/);
  });

  it('is done when every protein is caught, and then gives a code that belongs to the student', async () => {
    const first = await makeSpawn();
    const second = await makeSpawn();
    const row = await makeAssignment([first.id, second.id]);
    const userId = await makeUser('finisher');
    const mine = async () => (await listMyAssignments(userId)).find((item) => item.id === row.id)!;

    await catchSpawn({ userId, spawnId: first.id, ...NEAR });
    let view = await mine();
    assert.equal(view.caught, 1);
    assert.equal(view.total, 2);
    assert.equal(view.done, false);
    assert.equal(view.code, null);
    assert.deepEqual(await newlyCompleted(userId, first.id), []);

    await catchSpawn({ userId, spawnId: second.id, ...NEAR });
    view = await mine();
    assert.equal(view.done, true);
    assert.match(view.code ?? '', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(view.code, completionCode(row.id, userId));
    assert.equal(view.late, false);
    const finished = await newlyCompleted(userId, second.id);
    assert.deepEqual(finished.map((item) => item.id), [row.id]);
    assert.equal(finished[0].code, view.code);

    const other = userIds[1];
    assert.notEqual(completionCode(row.id, other), view.code);
  });

  it('marks a finish after the due date as late, without blocking it', async () => {
    const one = await makeSpawn();
    const row = await makeAssignment([one.id], { dueAt: new Date(Date.now() - 86_400_000) });
    const userId = await makeUser('latecomer');
    await catchSpawn({ userId, spawnId: one.id, ...NEAR });
    const view = (await listMyAssignments(userId)).find((item) => item.id === row.id)!;
    assert.equal(view.done, true);
    assert.equal(view.late, true);
  });

  it('can be deleted, and losing a protein shrinks the set', async () => {
    const keep = await makeSpawn();
    const drop = await makeSpawn();
    const row = await makeAssignment([keep.id, drop.id]);
    await db.delete(spawn).where(eq(spawn.id, drop.id));
    const listed = (await listAdminAssignments()).find((item) => item.id === row.id)!;
    assert.deepEqual(listed.spawns.map((item) => item.id), [keep.id]);
    await deleteAssignment(row.id);
    assert.equal((await listAdminAssignments()).some((item) => item.id === row.id), false);
    await fails(deleteAssignment(row.id), 404);
  });
});

describe('roster', () => {
  const quiz = { question: 'What carries oxygen in blood?', options: ['Actin', 'Hemoglobin', 'Keratin'], answerIndex: 1 };

  it('shows each student with progress, and the questions they got wrong', async () => {
    const hard = await makeSpawn({ quiz, name: `Hard ${run}` });
    const plain = await makeSpawn({ name: `Plain ${run}` });
    const row = await createAssignment({ title: `Roster ${run}`, dueAt: null, spawnIds: [hard.id, plain.id], createdBy: userIds[0] });
    assignmentIds.push(row.id);

    const fast = await makeUser('fast', 'Fran Fast');
    const slow = await makeUser('slow', 'Sol Slow');
    await catchSpawn({ userId: fast, spawnId: hard.id, ...NEAR, answer: 1 });
    await catchSpawn({ userId: fast, spawnId: plain.id, ...NEAR });
    await fails(catchSpawn({ userId: slow, spawnId: hard.id, ...NEAR, answer: 2 }), 422);
    await skipCooldown(slow);
    await catchSpawn({ userId: slow, spawnId: hard.id, ...NEAR, answer: 1 });

    const roster = await getRoster(row.id);
    assert.equal(roster.assignment?.id, row.id);
    const fastRow = roster.students.find((item) => item.userId === fast)!;
    const slowRow = roster.students.find((item) => item.userId === slow)!;
    assert.equal(fastRow.assignment?.done, true);
    assert.equal(fastRow.assignment?.code, completionCode(row.id, fast));
    assert.equal(fastRow.firstTry, 1);
    assert.equal(slowRow.assignment?.done, false);
    assert.equal(slowRow.assignment?.caught, 1);
    assert.equal(slowRow.assignment?.code, null);
    assert.equal(slowRow.wrongAnswers, 1);
    assert.equal(slowRow.firstTry, 0);

    // Only the quiz protein is a question, and it shows the popular wrong answer.
    assert.deepEqual(roster.questions.map((item) => item.spawnId), [hard.id]);
    const [question] = roster.questions;
    assert.equal(question.caught, 2);
    assert.equal(question.firstTryPercent, 50);
    assert.equal(question.wrongAnswers, 1);
    assert.deepEqual(question.topWrong, { answer: 'Keratin', count: 1 });

    await assert.rejects(getRoster('no-such-assignment'), (error: unknown) => error instanceof GameError && error.status === 404);
  });

  it('exports a CSV that a spreadsheet cannot turn into a formula', async () => {
    const one = await makeSpawn();
    const row = await createAssignment({ title: `CSV ${run}`, dueAt: null, spawnIds: [one.id], createdBy: userIds[0] });
    assignmentIds.push(row.id);
    const evil = await makeUser('evil', '=HYPERLINK("http://x"), Evil');
    await catchSpawn({ userId: evil, spawnId: one.id, ...NEAR });

    const file = await rosterCsv(row.id);
    assert.match(file.filename, /^proteingo-roster-\d{4}-\d{2}-\d{2}\.csv$/);
    assert.ok(file.body.startsWith('﻿Name,Email,Section,'));
    assert.ok(file.body.includes('"\'=HYPERLINK(""http://x""), Evil"'), 'formula is quoted and defused');
    assert.ok(file.body.includes(completionCode(row.id, evil)));
    assert.ok(file.body.includes('Completion code'));
  });
});
