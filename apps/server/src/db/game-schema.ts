import { doublePrecision, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
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

export const spawn = pgTable('spawn', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  summary: text('summary'),
  latitude: doublePrecision('latitude').notNull(),
  longitude: doublePrecision('longitude').notNull(),
  radiusMeters: integer('radius_meters').notNull(),
  modelKey: text('model_key'),
  modelFilename: text('model_filename'),
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
    caughtAt: timestamp('caught_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('capture_once').on(table.spawnId, table.userId)],
);
