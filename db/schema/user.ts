import { boolean, date, index, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { stores } from './org'
import { employees } from './employee'

/**
 * 顾客 / 客户端微信用户（合并原 customers + client_wechat_users）
 *
 * 行可由 (a) 微信登录创建，或 (b) WorkFine 同步创建。通过 phone 匹配合并行。
 * openid 可为 null（仅 WorkFine 同步创建的顾客）。
 */
export const clientWechatUsers = pgTable(
  'client_wechat_users',
  {
    /** 格式 FYGK-{YYYYMMDD}{序号} */
    userId: text('user_id').primaryKey(),
    /** 微信 openid（客户端 appid 下）；仅 WorkFine 同步创建的行为 null */
    openid: varchar('openid', { length: 64 }),
    sessionKey: varchar('session_key', { length: 128 }),
    phone: varchar('phone', { length: 30 }),
    /** WorkFine 顾客编号（UDF_S_1475），同步匹配用 */
    customerId: varchar('customer_id', { length: 30 }),
    // Layer 2 — WorkFine 档案
    name: varchar('name', { length: 50 }),
    registeredAt: date('registered_at'),
    // Layer 3 — 组织归属
    /** 同步时通过 store_name 匹配写入 */
    storeId: text('store_id').references(() => stores.storeId),
    /** 顾客端主动绑定的门店 */
    boundStoreId: text('bound_store_id').references(() => stores.storeId),
    primaryBeautician: varchar('primary_beautician', { length: 50 }),
    // Layer 4 — 会员与分类
    memberLevel: varchar('member_level', { length: 20 }),
    customerSource: varchar('customer_source', { length: 50 }),
    category: varchar('category', { length: 50 }),
    // Layer 5 — 个人档案
    birthday: date('birthday'),
    occupation: varchar('occupation', { length: 50 }),
    isMarried: boolean('is_married'),
    wechatName: varchar('wechat_name', { length: 50 }),
    // Layer 6 — 美容档案
    skinType: varchar('skin_type', { length: 50 }),
    improvementFocus: varchar('improvement_focus', { length: 200 }),
    skinIssue: varchar('skin_issue', { length: 200 }),
    wellnessPreference: varchar('wellness_preference', { length: 200 }),
    lastLoginAt: timestamp('last_login_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_client_users_openid').on(table.openid).where(sql`openid IS NOT NULL`),
    uniqueIndex('uq_client_users_phone').on(table.phone).where(sql`phone IS NOT NULL`),
    uniqueIndex('uq_client_users_customer_id').on(table.customerId).where(sql`customer_id IS NOT NULL`),
    index('idx_client_users_store_id').on(table.storeId),
    index('idx_client_users_bound_store_id').on(table.boundStoreId),
  ],
)

/**
 * 员工端微信用户
 */
export const staffWechatUsers = pgTable(
  'staff_wechat_users',
  {
    userId: text('user_id').primaryKey(),
    openid: varchar('openid', { length: 64 }).notNull().unique(),
    sessionKey: varchar('session_key', { length: 128 }),
    phone: varchar('phone', { length: 30 }),
    /** 手机号自动匹配后填入，FK → employees */
    employeeId: varchar('employee_id', { length: 30 }).references(() => employees.employeeId),
    lastLoginAt: timestamp('last_login_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    index('idx_staff_users_phone').on(table.phone),
    uniqueIndex('uq_staff_users_employee_id')
      .on(table.employeeId)
      .where(sql`employee_id IS NOT NULL`),
  ],
)

export type ClientWechatUser = typeof clientWechatUsers.$inferSelect
export type NewClientWechatUser = typeof clientWechatUsers.$inferInsert
export type StaffWechatUser = typeof staffWechatUsers.$inferSelect
export type NewStaffWechatUser = typeof staffWechatUsers.$inferInsert
