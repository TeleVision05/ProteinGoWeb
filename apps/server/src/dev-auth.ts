import type { FastifyRequest } from 'fastify';
import { user as userTable } from './db/auth-schema';
import { db } from './db/db';
import { isAdminEmail } from './game';

// Local-only sign-in that skips Google. Needs DEV_BYPASS_AUTH=true and is ignored in production.
// Nobody is signed in until a dev account is picked on the login page (the `dev_user` cookie).

export type DevRole = 'admin' | 'student';

export const DEV_COOKIE = 'dev_user';

export function devBypassEnabled() {
  return process.env.DEV_BYPASS_AUTH === 'true' && process.env.NODE_ENV !== 'production';
}

function accounts() {
  return {
    admin: {
      role: 'admin' as const,
      // Kept as the original id so existing dev data stays attached to this account.
      id: 'dev-bypass-user',
      email: (process.env.DEV_BYPASS_EMAIL ?? 'dev@ucr.edu').toLowerCase(),
      name: 'Dev Admin',
    },
    student: {
      role: 'student' as const,
      id: 'dev-student-user',
      email: (process.env.DEV_STUDENT_EMAIL ?? 'student@ucr.edu').toLowerCase(),
      name: 'Dev Student',
    },
  };
}

/** What the login page offers. A role is shown as admin only if the allowlist really makes it one. */
export function devAccountList() {
  if (!devBypassEnabled()) return [];
  return Object.values(accounts()).map((a) => ({
    role: a.role,
    email: a.email,
    name: a.name,
    isAdmin: isAdminEmail(a.email),
  }));
}

export function isDevRole(value: unknown): value is DevRole {
  return value === 'admin' || value === 'student';
}

export function readDevRole(request: FastifyRequest): DevRole | null {
  const raw = request.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === DEV_COOKIE) {
      const value = decodeURIComponent(rest.join('='));
      return isDevRole(value) ? value : null;
    }
  }
  return null;
}

export function devCookie(role: DevRole | null, secure: boolean) {
  const base = `${DEV_COOKIE}=${role ?? ''}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  return role ? `${base}; Max-Age=${60 * 60 * 24 * 7}` : `${base}; Max-Age=0`;
}

export async function devUser(role: DevRole) {
  const account = accounts()[role];
  await db
    .insert(userTable)
    .values({ id: account.id, name: account.name, email: account.email, emailVerified: true })
    .onConflictDoNothing();
  return { id: account.id, email: account.email, name: account.name, image: null };
}
