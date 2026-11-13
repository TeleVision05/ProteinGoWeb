import 'dotenv/config';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { account, session, user, verification } from './db/auth-schema';
import { db } from './db/db';
import { authBaseUrl, webOrigin } from './public-url';

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
  baseURL: authBaseUrl(),
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: [webOrigin()],
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
