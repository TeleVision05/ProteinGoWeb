import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { user } from '../db/auth-schema';
import { db } from '../db/db';
import { accessCode, capture, codeRedemption, spawn } from '../db/game-schema';
import { catchSpawn, createCode, createSpawn, distanceMeters, getAccess, redeemCode, revokeCode } from '../game';

async function main() {
  const userId = crypto.randomUUID();
  const email = `rule-check-${userId.slice(0, 8)}@ucr.edu`;
  await db.insert(user).values({
    id: userId,
    name: 'Rule Check',
    email,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const createdIds: string[] = [];
  const spawnIds: string[] = [];
  try {
    const code = await createCode({
      label: 'Lab section',
      expiresAt: new Date(Date.now() + 60_000),
      code: `CHK-${userId.slice(0, 8)}`,
      createdBy: userId,
    });
    if (!code) throw new Error('code was not created');
    createdIds.push(code.id);
    const access = await redeemCode(userId, code.code);
    if (!access.active || access.label !== 'Lab section') throw new Error('redeem did not open access');

    await revokeCode(code.id);
    const revoked = await getAccess(userId);
    if (revoked.active) throw new Error('revoked code should end access');

    const expiring = await createCode({
      label: 'Short',
      expiresAt: new Date(Date.now() + 60_000),
      createdBy: userId,
    });
    if (!expiring) throw new Error('second code was not created');
    createdIds.push(expiring.id);
    await redeemCode(userId, expiring.code);
    await db.update(accessCode).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(accessCode.id, expiring.id));
    const expired = await getAccess(userId);
    if (expired.active) throw new Error('expired code should end access');

    const placed = await createSpawn({
      name: 'Hemoglobin',
      summary: 'Bell Tower',
      latitude: 33.9737,
      longitude: -117.3281,
      radiusMeters: 30,
      expiresAt: null,
      createdBy: userId,
      file: null,
    });
    spawnIds.push(placed.id);

    let farFailed = false;
    try {
      await catchSpawn({ userId, spawnId: placed.id, latitude: 33.99, longitude: -117.35 });
    } catch {
      farFailed = true;
    }
    if (!farFailed) throw new Error('a catch from off campus should fail');

    const caught = await catchSpawn({
      userId,
      spawnId: placed.id,
      latitude: 33.97371,
      longitude: -117.32811,
    });
    if (!caught.caught) throw new Error('a catch inside the radius should succeed');
    const again = await catchSpawn({
      userId,
      spawnId: placed.id,
      latitude: 33.97371,
      longitude: -117.32811,
    });
    if (!again.already) throw new Error('the second catch should be a no-op');

    if (distanceMeters(0, 0, 0, 0) !== 0) throw new Error('zero distance');
    console.log('rules ok');
  } finally {
    for (const id of spawnIds) {
      await db.delete(capture).where(eq(capture.spawnId, id));
      await db.delete(spawn).where(eq(spawn.id, id));
    }
    for (const id of createdIds) {
      await db.delete(codeRedemption).where(eq(codeRedemption.codeId, id));
      await db.delete(accessCode).where(eq(accessCode.id, id));
    }
    await db.delete(user).where(eq(user.id, userId));
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
