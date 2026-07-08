import { bigserial, boolean, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'


export const skillTags = pgTable('skill_tags', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  sortOrder: integer('sort_order').notNull().default(0),
  isValid: boolean('is_valid').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`NOW()`),
})


export const projectSeriesLookup = pgTable('project_series_lookup', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  name: text('name').notNull().unique(),
  sortOrder: integer('sort_order').notNull().default(0),
  isValid: boolean('is_valid').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`NOW()`),
})

export type SkillTag = typeof skillTags.$inferSelect
export type NewSkillTag = typeof skillTags.$inferInsert
export type ProjectSeries = typeof projectSeriesLookup.$inferSelect
export type NewProjectSeries = typeof projectSeriesLookup.$inferInsert
