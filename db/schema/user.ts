import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * 实体四：客户端微信用户
 *
 * 两个小程序 appid 不同，客户端与员工端 openid 相互独立，拆为两张表。
 */
export const clientWechatUsers = pgTable('client_wechat_users', {
  userId: text('user_id').primaryKey(),
  /** 微信 openid（客户端 appid 下），唯一索引 */
  openid: text('openid').notNull().unique(),
  /** 微信 session_key，加密存储 */
  sessionKey: text('session_key'),
  /** 绑定手机号，与 WorkFine customers.phone 核对 */
  phone: text('phone'),
  /** 顾客端绑定门店名，来自 UDT_M_219.UDF_M_438，初始为 null */
  boundStoreName: text('bound_store_name'),
  lastLoginAt: timestamp('last_login_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

/**
 * 实体四：员工端微信用户
 */
export const staffWechatUsers = pgTable('staff_wechat_users', {
  userId: text('user_id').primaryKey(),
  /** 微信 openid（员工端 appid 下），唯一索引 */
  openid: text('openid').notNull().unique(),
  sessionKey: text('session_key'),
  phone: text('phone'),
  /** 关联 WorkFine UDT_S_287.UDF_S_1147，绑定手机号后自动匹配，可为 null */
  staffWfId: text('staff_wf_id'),
  lastLoginAt: timestamp('last_login_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export type ClientWechatUser = typeof clientWechatUsers.$inferSelect
export type NewClientWechatUser = typeof clientWechatUsers.$inferInsert
export type StaffWechatUser = typeof staffWechatUsers.$inferSelect
export type NewStaffWechatUser = typeof staffWechatUsers.$inferInsert
