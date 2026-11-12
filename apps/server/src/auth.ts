import 'dotenv/config';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { account, session, user, verification } from './db/auth-schema';
import { db } from './db/db';

function assertUcrEmail(email: string | null | undefined) {
  const normalized = email?.trim().toLowerCase() ?? '';
  if (!normalized.endsWith('@ucr.edu')) {
    throw new APIError('FORBIDDEN', {
      message: 'Sign in with a ucr.edu Google account.',
    });
  }
  return normalized;
}

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: [process.env.WEB_ORIGIN ?? 'http://localhost:5173'],
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: { user, session, account, verification },
  }),
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || 'missing',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'missing',
      hd: 'ucr.edu',
      prompt: 'select_account',
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const email = assertUcrEmail(user.email);
          return { data: { ...user, email } };
        },
      },
    },
  },
});

export type Auth = typeof auth;
