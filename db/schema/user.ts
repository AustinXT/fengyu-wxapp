import { bigint, boolean, check, date, integer, index, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { stores, orgNodes } from './org'
import { customerTypeEnum, customerStatusEnum, monthlyActivityEnum, spendingTierEnum, memberLevelEnum, customerSourceEnum } from './enums'


export const clientWechatUsers = pgTable(
  'client_wechat_users',
  {
    
    userId: text('user_id').primaryKey(),
    
    openid: varchar('openid', { length: 64 }),
    sessionKey: varchar('session_key', { length: 128 }),
    phone: varchar('phone', { length: 30 }),
    
    customerId: varchar('customer_id', { length: 30 }),
    
    name: varchar('name', { length: 50 }),
    gender: varchar('gender', { length: 10 }),
    
    avatarUrl: text('avatar_url'),
    
    
    boundStoreId: text('bound_store_id').references(() => stores.storeId),
    
    boundEmployeeId: varchar('bound_employee_id', { length: 50 }),
    
    boundEmployeeName: varchar('bound_employee_name', { length: 50 }),
    
    isCrossStoreTemp: boolean('is_cross_store_temp').notNull().default(false),
    
    memberLevel: memberLevelEnum('member_level'),
    
    memberLevelLockedUntil: timestamp('member_level_locked_until', { withTimezone: true }),
    
    memberLevelUpgradedAt: timestamp('member_level_upgraded_at', { withTimezone: true }),
    
    oldMemberLevel: memberLevelEnum('old_member_level'),
    customerSource: customerSourceEnum('customer_source'),
    
    promoterEmployeeId: varchar('promoter_employee_id', { length: 30 }).references((): any => staffWechatUsers.employeeId),
    
    inviterUserId: text('inviter_user_id').references((): any => clientWechatUsers.userId),
    
    invitedAt: timestamp('invited_at'),
    
    customerType: customerTypeEnum('customer_type').notNull().default('流量客'),
    
    becameMemberAt: timestamp('became_member_at', { withTimezone: true }),
    
    spendingTier: spendingTierEnum('spending_tier').notNull().default('<1990'),
    
    monthlyActivity: monthlyActivityEnum('monthly_activity'),
    
    customerStatus: customerStatusEnum('customer_status'),
    
    birthday: date('birthday'),
    occupation: varchar('occupation', { length: 50 }),
    isMarried: boolean('is_married'),
    wechatName: varchar('wechat_name', { length: 50 }),
    
    skinType: varchar('skin_type', { length: 50 }),
    improvementFocus: varchar('improvement_focus', { length: 200 }),
    skinIssue: varchar('skin_issue', { length: 200 }),
    wellnessPreference: varchar('wellness_preference', { length: 200 }),
    notes: text('notes'),
    
    pointsBalance: bigint('points_balance', { mode: 'number' }).notNull().default(0),
    
    pointsUpdatedAt: timestamp('points_updated_at'),
    lastLoginAt: timestamp('last_login_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    uniqueIndex('uq_client_users_openid').on(table.openid).where(sql`openid IS NOT NULL`),
    uniqueIndex('uq_client_users_phone').on(table.phone).where(sql`phone IS NOT NULL`),
    uniqueIndex('uq_client_users_customer_id').on(table.customerId).where(sql`customer_id IS NOT NULL`),
    index('idx_client_users_bound_store_id').on(table.boundStoreId),
    index('idx_client_users_inviter').on(table.inviterUserId).where(sql`inviter_user_id IS NOT NULL`),
    check('chk_inviter_not_self', sql`${table.inviterUserId} IS NULL OR ${table.inviterUserId} <> ${table.userId}`),
    check('chk_cwu_phone_format', sql`${table.phone} IS NULL OR ${table.phone} ~ '^1[3-9][0-9]{9}$'`),
  ],
)


export const staffWechatUsers = pgTable(
  'staff_wechat_users',
  {
    
    employeeId: varchar('employee_id', { length: 30 }).primaryKey(),
    
    openid: varchar('openid', { length: 64 }),
    sessionKey: varchar('session_key', { length: 128 }),
    phone: varchar('phone', { length: 30 }),
    
    name: varchar('name', { length: 50 }),
    gender: varchar('gender', { length: 20 }),
    
    idCard: varchar('id_card', { length: 200 }),
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storeId: text('store_id').references((): any => stores.storeId),
    
    orgNodeId: text('org_node_id').references(() => orgNodes.id),
    positionName: varchar('position_name', { length: 50 }),
    
    avatarUrl: text('avatar_url'),
    
    birthday: date('birthday'),
    
    leaveStart: timestamp('leave_start', { mode: 'string' }),
    
    leaveEnd: timestamp('leave_end', { mode: 'string' }),
    
    isOnBusinessTrip: boolean('is_on_business_trip').notNull().default(false),
    
    skills: text('skills').array(),
    
    socialInsurance: boolean('social_insurance').notNull().default(false),
    isResigned: boolean('is_resigned').notNull().default(false),
    
    hiredAt: date('hired_at'),
    
    resignedAt: date('resigned_at'),
    
    resignationReason: text('resignation_reason'),
    lastLoginAt: timestamp('last_login_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    uniqueIndex('uq_staff_users_openid').on(table.openid).where(sql`openid IS NOT NULL`),
    uniqueIndex('uq_staff_users_phone').on(table.phone).where(sql`phone IS NOT NULL`),
    index('idx_staff_users_store_resigned').on(table.storeId, table.isResigned),
    check('chk_swu_phone_format', sql`${table.phone} IS NULL OR ${table.phone} ~ '^1[3-9][0-9]{9}$'`),
    check('chk_swu_leave_range', sql`${table.leaveStart} IS NULL OR ${table.leaveEnd} IS NULL OR ${table.leaveEnd} > ${table.leaveStart}`),
  ],
)

export type ClientWechatUser = typeof clientWechatUsers.$inferSelect
export type NewClientWechatUser = typeof clientWechatUsers.$inferInsert
export type StaffWechatUser = typeof staffWechatUsers.$inferSelect
export type NewStaffWechatUser = typeof staffWechatUsers.$inferInsert
