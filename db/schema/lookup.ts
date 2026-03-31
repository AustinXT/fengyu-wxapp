import { boolean, integer, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core'
import { positionScopeEnum } from './enums'

/**
 * 职位表
 *
 * 按 scope（总部/市场/门店）分类，作为员工管理中职位下拉的选项来源。
 * staff_wechat_users.position_name 保持 text 不改 FK，此表仅提供 UI 选项。
 */
export const positions = pgTable('positions', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  scope: positionScopeEnum('scope').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  isValid: boolean('is_valid').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  unique('uq_positions_name_scope').on(table.name, table.scope),
])

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

export type Position = typeof positions.$inferSelect
export type NewPosition = typeof positions.$inferInsert
export type SkillTag = typeof skillTags.$inferSelect
export type NewSkillTag = typeof skillTags.$inferInsert
