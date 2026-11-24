// Class assignments, the teacher's roster and the CSV export.
import { createHmac } from 'node:crypto';
import { asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from './db/db';
import { user } from './db/auth-schema';
import { accessCode, assignment, assignmentSpawn, capture, codeRedemption, quizAttempt, spawn } from './db/game-schema';
import { GameError } from './game';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 letters and digits, no look-alikes
const MAX_PROTEINS = 50;

type AssignmentRow = {
  id: string;
  title: string;
  dueAt: Date | null;
  createdAt: Date;
  spawns: { id: string; name: string }[];
};

/**
 * The code a student hands in for an assignment. It is derived from the assignment and the student, so it is the same
 * every time they open the page, can't be guessed, and the teacher can check it against the roster. Two students never
 * share one. It only works as proof while BETTER_AUTH_SECRET stays the same.
 */
export function completionCode(assignmentId: string, userId: string) {
  const secret = process.env.BETTER_AUTH_SECRET || 'proteingo-dev-secret';
  const digest = createHmac('sha256', secret).update(`completion:${assignmentId}:${userId}`).digest();
  const letters = Array.from(digest.subarray(0, 8), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

async function loadAssignments(id?: string): Promise<AssignmentRow[]> {
  const rows = await db.select().from(assignment).where(id ? eq(assignment.id, id) : undefined).orderBy(asc(assignment.createdAt));
  if (!rows.length) return [];
  const links = await db
    .select({ assignmentId: assignmentSpawn.assignmentId, id: spawn.id, name: spawn.name })
    .from(assignmentSpawn)
    .innerJoin(spawn, eq(assignmentSpawn.spawnId, spawn.id))
    .where(
      inArray(
        assignmentSpawn.assignmentId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(spawn.name));
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    dueAt: row.dueAt,
    createdAt: row.createdAt,
    spawns: links.filter((link) => link.assignmentId === row.id).map((link) => ({ id: link.id, name: link.name })),
  }));
}

/** Done = every protein in the set caught. completedAt is the catch that finished it. */
function progressOn(row: AssignmentRow, caughtAt: Map<string, Date>) {
  const times = row.spawns.map((item) => caughtAt.get(item.id)).filter((time): time is Date => Boolean(time));
  const done = row.spawns.length > 0 && times.length === row.spawns.length;
  const completedAt = done ? new Date(Math.max(...times.map((time) => time.getTime()))) : null;
  const late = Boolean(row.dueAt && completedAt && completedAt > row.dueAt);
  return { caught: times.length, done, completedAt, late };
}

// ---- Teacher: create, list, delete ------------------------------------------------------------

export async function createAssignment(input: { title: string; dueAt: Date | null; spawnIds: string[]; createdBy: string }) {
  const title = input.title.trim();
  if (title.length < 2 || title.length > 80) throw new GameError('Give the assignment a title of 2 to 80 characters.', 400);
  if (input.dueAt && Number.isNaN(input.dueAt.getTime())) throw new GameError('The due date is not valid.', 400);
  const spawnIds = [...new Set(input.spawnIds)];
  if (!spawnIds.length) throw new GameError('Pick at least one protein for the assignment.', 400);
  if (spawnIds.length > MAX_PROTEINS) throw new GameError(`An assignment can have up to ${MAX_PROTEINS} proteins.`, 400);
  const found = await db.select({ id: spawn.id }).from(spawn).where(inArray(spawn.id, spawnIds));
  if (found.length !== spawnIds.length) throw new GameError('One of those proteins no longer exists.', 400);

  const id = crypto.randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(assignment).values({ id, title, dueAt: input.dueAt, createdBy: input.createdBy, createdAt: new Date() });
    await tx.insert(assignmentSpawn).values(spawnIds.map((spawnId) => ({ assignmentId: id, spawnId })));
  });
  const [row] = await loadAssignments(id);
  return serializeAssignment(row);
}

function serializeAssignment(row: AssignmentRow) {
  return {
    id: row.id,
    title: row.title,
    dueAt: row.dueAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    spawns: row.spawns,
  };
}

export async function listAdminAssignments() {
  return (await loadAssignments()).map(serializeAssignment);
}

export async function deleteAssignment(id: string) {
  const removed = await db.delete(assignment).where(eq(assignment.id, id)).returning({ id: assignment.id });
  if (!removed.length) throw new GameError('That assignment no longer exists.', 404);
  return { ok: true };
}

// ---- Student: my assignments ------------------------------------------------------------------

async function capturesOf(userId: string) {
  const rows = await db.select({ spawnId: capture.spawnId, caughtAt: capture.caughtAt }).from(capture).where(eq(capture.userId, userId));
  return new Map(rows.map((row) => [row.spawnId, row.caughtAt]));
}

function studentView(row: AssignmentRow, userId: string, caughtAt: Map<string, Date>) {
  const state = progressOn(row, caughtAt);
  return {
    id: row.id,
    title: row.title,
    dueAt: row.dueAt?.toISOString() ?? null,
    total: row.spawns.length,
    caught: state.caught,
    done: state.done,
    completedAt: state.completedAt?.toISOString() ?? null,
    late: state.late,
    // Only a finished assignment has a code.
    code: state.done ? completionCode(row.id, userId) : null,
    proteins: row.spawns.map((item) => ({
      id: item.id,
      name: item.name,
      caught: caughtAt.has(item.id),
      caughtAt: caughtAt.get(item.id)?.toISOString() ?? null,
    })),
  };
}

export async function listMyAssignments(userId: string) {
  const [rows, caughtAt] = await Promise.all([loadAssignments(), capturesOf(userId)]);
  return rows.filter((row) => row.spawns.length > 0).map((row) => studentView(row, userId, caughtAt));
}

/** Assignments that this catch just finished (it contains the protein and every other one is already caught). */
export async function newlyCompleted(userId: string, spawnId: string) {
  const [rows, caughtAt] = await Promise.all([loadAssignments(), capturesOf(userId)]);
  return rows
    .filter((row) => row.spawns.some((item) => item.id === spawnId) && progressOn(row, caughtAt).done)
    .map((row) => ({ id: row.id, title: row.title, code: completionCode(row.id, userId) }));
}

// ---- Teacher: roster and question analytics ---------------------------------------------------

export async function getRoster(assignmentId?: string | null) {
  let selected: AssignmentRow | null = null;
  if (assignmentId) {
    [selected] = await loadAssignments(assignmentId);
    if (!selected) throw new GameError('That assignment no longer exists.', 404);
  }

  const [redemptions, captures, answers, quizSpawns] = await Promise.all([
    db
      .select({ userId: codeRedemption.userId, label: accessCode.label })
      .from(codeRedemption)
      .innerJoin(accessCode, eq(codeRedemption.codeId, accessCode.id)),
    db
      .select({ userId: capture.userId, spawnId: capture.spawnId, xp: capture.xp, attempts: capture.attempts, caughtAt: capture.caughtAt })
      .from(capture),
    db
      .select({
        userId: quizAttempt.userId,
        spawnId: quizAttempt.spawnId,
        answerIndex: quizAttempt.answerIndex,
        correct: quizAttempt.correct,
        count: sql<number>`cast(count(*) as int)`,
      })
      .from(quizAttempt)
      .groupBy(quizAttempt.userId, quizAttempt.spawnId, quizAttempt.answerIndex, quizAttempt.correct),
    db.select({ id: spawn.id, name: spawn.name, quiz: spawn.quiz }).from(spawn).where(isNotNull(spawn.quiz)),
  ]);

  const quizIds = new Set(quizSpawns.map((row) => row.id));
  const userIds = [...new Set([...redemptions.map((r) => r.userId), ...captures.map((r) => r.userId), ...answers.map((r) => r.userId)])];
  const people = userIds.length
    ? await db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(inArray(user.id, userIds))
    : [];

  const students = people
    .map((person) => {
      const mine = captures.filter((row) => row.userId === person.id);
      const caughtAt = new Map(mine.map((row) => [row.spawnId, row.caughtAt]));
      const state = selected ? progressOn(selected, caughtAt) : null;
      const last = mine.reduce<Date | null>((best, row) => (!best || row.caughtAt > best ? row.caughtAt : best), null);
      return {
        userId: person.id,
        name: person.name,
        email: person.email,
        sections: [...new Set(redemptions.filter((row) => row.userId === person.id).map((row) => row.label))].sort(),
        caught: mine.length,
        xp: mine.reduce((sum, row) => sum + row.xp, 0),
        firstTry: mine.filter((row) => quizIds.has(row.spawnId) && row.attempts === 1).length,
        wrongAnswers: answers.filter((row) => row.userId === person.id && !row.correct).reduce((sum, row) => sum + Number(row.count), 0),
        lastCatch: last?.toISOString() ?? null,
        assignment:
          selected && state
            ? {
                caught: state.caught,
                total: selected.spawns.length,
                done: state.done,
                completedAt: state.completedAt?.toISOString() ?? null,
                late: state.late,
                code: state.done ? completionCode(selected.id, person.id) : null,
              }
            : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const scope = selected ? new Set(selected.spawns.map((item) => item.id)) : null;
  const questions = quizSpawns
    .filter((row) => !scope || scope.has(row.id))
    .map((row) => {
      const caught = captures.filter((item) => item.spawnId === row.id);
      const attempts = answers.filter((item) => item.spawnId === row.id);
      const wrong = attempts.filter((item) => !item.correct);
      const byOption = new Map<number, number>();
      for (const item of wrong) byOption.set(item.answerIndex, (byOption.get(item.answerIndex) ?? 0) + Number(item.count));
      const [top] = [...byOption.entries()].sort((a, b) => b[1] - a[1]);
      const firstTry = caught.filter((item) => item.attempts === 1).length;
      return {
        spawnId: row.id,
        name: row.name,
        question: row.quiz?.question ?? '',
        students: new Set(attempts.map((item) => item.userId)).size,
        caught: caught.length,
        firstTryPercent: caught.length ? Math.round((firstTry / caught.length) * 100) : null,
        wrongAnswers: wrong.reduce((sum, item) => sum + Number(item.count), 0),
        topWrong: top ? { answer: row.quiz?.options[top[0]] ?? `Option ${top[0] + 1}`, count: top[1] } : null,
      };
    })
    // The questions most worth going over in lab come first.
    .sort((a, b) => b.wrongAnswers - a.wrongAnswers || a.name.localeCompare(b.name));

  return {
    assignment: selected ? serializeAssignment(selected) : null,
    students,
    questions,
  };
}

/** One CSV cell. A leading = + - @ would make a spreadsheet run the cell as a formula, so those get a quote in front. */
function cell(value: string | number | null | undefined) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function rosterCsv(assignmentId?: string | null) {
  const roster = await getRoster(assignmentId);
  const header = ['Name', 'Email', 'Section', 'Proteins caught', 'XP', 'First-try quiz answers', 'Wrong answers', 'Last catch'];
  if (roster.assignment) header.push('Assignment', 'Required caught', 'Required total', 'Completed', 'Completed at', 'On time', 'Completion code');
  const lines = [header.map(cell).join(',')];
  for (const student of roster.students) {
    const row: (string | number | null)[] = [
      student.name,
      student.email,
      student.sections.join('; '),
      student.caught,
      student.xp,
      student.firstTry,
      student.wrongAnswers,
      student.lastCatch,
    ];
    if (roster.assignment && student.assignment) {
      const a = student.assignment;
      row.push(
        roster.assignment.title,
        a.caught,
        a.total,
        a.done ? 'Yes' : 'No',
        a.completedAt,
        a.done ? (a.late ? 'Late' : 'On time') : '',
        a.code,
      );
    }
    lines.push(row.map(cell).join(','));
  }
  // The byte order mark makes Excel read accented names as UTF-8.
  return { filename: `proteingo-roster-${new Date().toISOString().slice(0, 10)}.csv`, body: `﻿${lines.join('\r\n')}\r\n` };
}
