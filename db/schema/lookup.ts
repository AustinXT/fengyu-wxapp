import { bigserial, boolean, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * 技能标签表
 *
 * 作为员工管理中技能标签多选的选项来源。
 * staff_wechat_users.skills 保持 text[] 不变，此表仅提供 UI 选项。
 */
export const skillTags = pgTable('skill_tags', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  sortOrder: integer('sort_order').notNull().default(0),
  isValid: boolean('is_valid').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
})

/**
 * 项目系列表
 *
 * 作为商品 SKU 中"项目系列"下拉的选项来源（如"美学类(面部)"、"健康类(身体)"）。
 * product_skus.project_series_id FK 指向本表。运营在 admin 端可后续扩展该字典。
 */
export const projectSeriesLookup = pgTable('project_series_lookup', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  name: text('name').notNull().unique(),
  sortOrder: integer('sort_order').notNull().default(0),
  isValid: boolean('is_valid').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
})

export type SkillTag = typeof skillTags.$inferSelect
export type NewSkillTag = typeof skillTags.$inferInsert
export type ProjectSeries = typeof projectSeriesLookup.$inferSelect
export type NewProjectSeries = typeof projectSeriesLookup.$inferInsert
