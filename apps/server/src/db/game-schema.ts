import { doublePrecision, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth-schema';

export const accessCode = pgTable('access_code', {
  id: text('id').primaryKey(),
  code: text('code').notNull().unique(),
  label: text('label').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const codeRedemption = pgTable(
  'code_redemption',
  {
    id: text('id').primaryKey(),
    codeId: text('code_id')
      .notNull()
      .references(() => accessCode.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('code_redemption_once').on(table.codeId, table.userId)],
);

export type ModelVariant = { style: 'sphere' | 'ribbon'; lod: 0 | 1; key: string; filename: string | null };

export const spawn = pgTable('spawn', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  summary: text('summary'),
  latitude: doublePrecision('latitude').notNull(),
  longitude: doublePrecision('longitude').notNull(),
  radiusMeters: integer('radius_meters').notNull(),
  modelKey: text('model_key'),
  modelFilename: text('model_filename'),
  /** common | uncommon | rare | legendary: sets the XP for catching it. */
  rarity: text('rarity').notNull().default('common'),
  /** Optional question the player answers to catch it: { question, options, answerIndex }. */
  quiz: jsonb('quiz').$type<{ question: string; options: string[]; answerIndex: number }>(),
  /** Model files per style (sphere / ribbon) and level of detail (0 = full, 1 = low). */
  variants: jsonb('variants').$type<ModelVariant[]>().notNull().default([]),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const capture = pgTable(
  'capture',
  {
    id: text('id').primaryKey(),
    spawnId: text('spawn_id')
      .notNull()
      .references(() => spawn.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),
    /** XP awarded for this catch (rarity reward plus any first-try quiz bonus). */
    xp: integer('xp').notNull().default(0),
    /** Quiz tries it took (1 = right first time). */
    attempts: integer('attempts').notNull().default(1),
    caughtAt: timestamp('caught_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('capture_once').on(table.spawnId, table.userId)],
);

/** Small key/value switches the admin can flip, e.g. leaderboard_enabled. */
export const appSetting = pgTable('app_setting', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
