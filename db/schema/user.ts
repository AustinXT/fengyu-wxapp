import { boolean, date, integer, index, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { stores, orgNodes } from './org'
import { customerTypeEnum, customerStatusEnum, monthlyActivityEnum, spendingTierEnum, memberLevelEnum, customerSourceEnum } from './enums'

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
    gender: varchar('gender', { length: 10 }),
    /** 头像 URL（顾客端个人中心设置） */
    avatarUrl: text('avatar_url'),
    // Layer 3 — 组织归属
    /** 顾客绑定的门店（同步写入 or 顾客端主动绑定） */
    boundStoreId: text('bound_store_id').references(() => stores.storeId),
    /** 绑定美容师（同步写入 or 营业额分配默认人员） */
    boundEmployeeId: varchar('bound_employee_id', { length: 50 }),
    /** 绑定美容师姓名（冗余，随 boundEmployeeId 同步写入） */
    boundEmployeeName: varchar('bound_employee_name', { length: 50 }),
    // Layer 4 — 会员与分类
    memberLevel: memberLevelEnum('member_level'),
    customerSource: customerSourceEnum('customer_source'),
    /** 推荐人（美容师员工ID） */
    promoterEmployeeId: varchar('promoter_employee_id', { length: 30 }).references((): any => staffWechatUsers.employeeId),
    /** 顾客类型：流量客/体验客/小美客/会员客，默认流量客 */
    customerType: customerTypeEnum('customer_type').notNull().default('流量客'),
    /** 历史消费档位：按累计消费额分档，默认<1990（未被经营） */
    spendingTier: spendingTierEnum('spending_tier').notNull().default('<1990'),
    /** 月度客活：每日凌晨3点根据当月已完成服务单计算 */
    monthlyActivity: monthlyActivityEnum('monthly_activity'),
    /** 到店状态：基于服务单历史自动计算，每日凌晨3点更新 */
    customerStatus: customerStatusEnum('customer_status'),
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
    notes: text('notes'),
    lastLoginAt: timestamp('last_login_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_client_users_openid').on(table.openid).where(sql`openid IS NOT NULL`),
    uniqueIndex('uq_client_users_phone').on(table.phone).where(sql`phone IS NOT NULL`),
    uniqueIndex('uq_client_users_customer_id').on(table.customerId).where(sql`customer_id IS NOT NULL`),
    index('idx_client_users_bound_store_id').on(table.boundStoreId),
  ],
)

/**
 * 员工端微信用户（合并原 employees + staff_wechat_users）
 *
 * 行仅由 WorkFine 同步创建（employee_id 为 PK）。
 * 微信登录不建行；绑定手机号时按 phone 找到同步行，写入 openid。
 * openid 可为 null（仅 WorkFine 同步创建的员工）。
 */
export const staffWechatUsers = pgTable(
  'staff_wechat_users',
  {
    /** 员工编号（WorkFine UDF_S_1147），主键，供其他表 FK 引用 */
    employeeId: varchar('employee_id', { length: 30 }).primaryKey(),
    /** 微信 openid（员工端 appid 下）；仅 WorkFine 同步创建的行为 null */
    openid: varchar('openid', { length: 64 }),
    sessionKey: varchar('session_key', { length: 128 }),
    phone: varchar('phone', { length: 30 }),
    // Layer 2 — WorkFine 档案
    name: varchar('name', { length: 50 }),
    gender: varchar('gender', { length: 20 }),
    /** 身份证号码（AES-256-GCM 加密存储） */
    idCard: varchar('id_card', { length: 200 }),
    // Layer 3 — 组织归属
    storeId: text('store_id').references(() => stores.storeId),
    /** 指向 type='部门' 的部门节点（挂在所属门店 org_node 下，无门店员工挂总部） */
    orgNodeId: text('org_node_id').references(() => orgNodes.id),
    positionName: varchar('position_name', { length: 50 }),
    // Layer 4 — 个人档案
    birthday: date('birthday'),
    /** 技能标签数组，由员工端手动维护 */
    skills: text('skills').array(),
    isResigned: boolean('is_resigned').notNull().default(false),
    lastLoginAt: timestamp('last_login_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_staff_users_openid').on(table.openid).where(sql`openid IS NOT NULL`),
    uniqueIndex('uq_staff_users_phone').on(table.phone).where(sql`phone IS NOT NULL`),
    index('idx_staff_users_store_resigned').on(table.storeId, table.isResigned),
  ],
)

export type ClientWechatUser = typeof clientWechatUsers.$inferSelect
export type NewClientWechatUser = typeof clientWechatUsers.$inferInsert
export type StaffWechatUser = typeof staffWechatUsers.$inferSelect
export type NewStaffWechatUser = typeof staffWechatUsers.$inferInsert
