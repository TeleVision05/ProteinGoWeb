import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildAchievements, levelFor, publicName, rewardFor, streaks, type ProgressStats } from '../progress';
import { distanceMeters, parseQuiz, scatterPoints } from '../game';

const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe('levels', () => {
  it('starts at level 1 and climbs on a square curve', () => {
    assert.equal(levelFor(0).level, 1);
    assert.equal(levelFor(49).level, 1);
    assert.equal(levelFor(50).level, 2);
    assert.equal(levelFor(199).level, 2);
    assert.equal(levelFor(200).level, 3);
  });

  it('reports progress inside the level', () => {
    const { level, levelXp, levelSpan } = levelFor(75);
    assert.equal(level, 2);
    assert.equal(levelXp, 25);
    assert.equal(levelSpan, 150);
  });
});

describe('rewards', () => {
  it('pays more for rarer proteins', () => {
    assert.equal(rewardFor('common', false).xp, 10);
    assert.equal(rewardFor('legendary', false).xp, 100);
  });

  it('adds a bonus only for a first-try quiz', () => {
    assert.equal(rewardFor('rare', true).bonus, 25);
    assert.equal(rewardFor('rare', false).bonus, 0);
  });

  it('treats an unknown rarity as common', () => {
    assert.equal(rewardFor('mythic', false).xp, 10);
  });
});

describe('streaks', () => {
  const now = day('2026-11-17');

  it('counts consecutive days ending today', () => {
    const run = streaks([day('2026-11-15'), day('2026-11-16'), day('2026-11-17')], now);
    assert.deepEqual(run, { current: 3, best: 3 });
  });

  it('keeps the streak alive until the day after the last catch ends', () => {
    assert.equal(streaks([day('2026-11-15'), day('2026-11-16')], now).current, 2);
    assert.equal(streaks([day('2026-11-14'), day('2026-11-15')], now).current, 0);
  });

  it('remembers the best run after a gap', () => {
    const run = streaks([day('2026-11-01'), day('2026-11-02'), day('2026-11-03'), day('2026-11-17')], now);
    assert.deepEqual(run, { current: 1, best: 3 });
  });

  it('counts several catches on one day once', () => {
    assert.equal(streaks([day('2026-11-17'), day('2026-11-17')], now).current, 1);
  });

  it('is zero with no catches', () => {
    assert.deepEqual(streaks([], now), { current: 0, best: 0 });
  });
});

describe('achievements', () => {
  const base: ProgressStats = {
    caught: 0,
    activeCaught: 0,
    totalSpawns: 4,
    streak: 0,
    bestStreak: 0,
    byRarity: { common: 0, uncommon: 0, rare: 0, legendary: 0 },
    firstTryQuizzes: 0,
  };
  const unlocked = (stats: ProgressStats) => buildAchievements(stats).filter((a) => a.unlocked).map((a) => a.id);

  it('unlocks nothing at the start', () => {
    assert.deepEqual(unlocked(base), []);
  });

  it('unlocks by catch count and rarity', () => {
    const ids = unlocked({ ...base, caught: 5, byRarity: { ...base.byRarity, rare: 1 } });
    assert.deepEqual(ids.sort(), ['collector-5', 'first-catch', 'rare-find']);
  });

  it('needs a real set for Full set', () => {
    assert.ok(!unlocked({ ...base, totalSpawns: 2, caught: 2, activeCaught: 2 }).includes('full-set'));
    assert.ok(unlocked({ ...base, totalSpawns: 4, caught: 4, activeCaught: 4 }).includes('full-set'));
  });

  it('caps progress at the target', () => {
    const first = buildAchievements({ ...base, caught: 9 }).find((a) => a.id === 'collector-5');
    assert.equal(first?.progress, 5);
  });
});

describe('names', () => {
  it('shortens to first name and last initial', () => {
    assert.equal(publicName('Alex Rivera'), 'Alex R.');
    assert.equal(publicName('Sam'), 'Sam');
    assert.equal(publicName('  '), 'Player');
  });
});

describe('distance', () => {
  it('is zero for the same point and about 111 km per degree of latitude', () => {
    assert.equal(distanceMeters(10, 10, 10, 10), 0);
    const meters = distanceMeters(0, 0, 1, 0);
    assert.ok(meters > 110_000 && meters < 112_000);
  });
});

describe('quiz parsing', () => {
  const good = { question: 'Which carries oxygen?', options: ['Hemoglobin', 'Actin'], answerIndex: 0 };

  it('accepts an object or its JSON, and empty means no quiz', () => {
    assert.deepEqual(parseQuiz(good), good);
    assert.deepEqual(parseQuiz(JSON.stringify(good)), good);
    assert.equal(parseQuiz(''), null);
    assert.equal(parseQuiz(null), null);
  });

  it('rejects broken quizzes', () => {
    assert.throws(() => parseQuiz({ ...good, options: ['Only one'] }), /2 to 4/);
    assert.throws(() => parseQuiz({ ...good, answerIndex: 5 }), /correct/);
    assert.throws(() => parseQuiz({ ...good, options: ['Same', 'same'] }), /different/);
    assert.throws(() => parseQuiz({ ...good, question: '?' }), /question/);
    assert.throws(() => parseQuiz('{nope'), /not valid/);
  });
});

describe('scatterPoints', () => {
  it('stays inside the area and makes the requested count', () => {
    const center = { latitude: 33.9737, longitude: -117.3281 };
    const points = scatterPoints(center, 200, 20, 10);
    assert.equal(points.length, 20);
    for (const point of points) {
      assert.ok(distanceMeters(center.latitude, center.longitude, point.latitude, point.longitude) <= 201);
    }
  });

  it('keeps spacing when there is room', () => {
    const points = scatterPoints({ latitude: 0, longitude: 0 }, 500, 10, 40);
    for (const [i, a] of points.entries()) {
      for (const b of points.slice(i + 1)) {
        assert.ok(distanceMeters(a.latitude, a.longitude, b.latitude, b.longitude) >= 40);
      }
    }
  });
});
