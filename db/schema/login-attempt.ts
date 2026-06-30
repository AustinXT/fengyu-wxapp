import { bigserial, integer, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/**
 * 管理后台登录失败锁定（持久化防爆破）
 *
 * 替代原 auth.ts 进程内存 Map：多实例部署 / 进程重启后锁定状态不丢失。
 * 以手机号为粒度记录连续失败次数，超过阈值后写入 lockedUntil。
 * 登录成功时删除对应行（clearFailure）。
 */
export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** 登录手机号（锁定粒度键） */
    phone: varchar('phone', { length: 20 }).notNull(),
    /** 当前连续失败次数 */
    failCount: integer('fail_count').notNull().default(0),
    /** 锁定到期时间；NULL 或已过期表示未锁定 */
    lockedUntil: timestamp('locked_until'),
    /** 最近一次失败时间 */
    lastFailedAt: timestamp('last_failed_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    uniqueIndex('uq_login_attempts_phone').on(table.phone),
  ],
)

export type LoginAttempt = typeof loginAttempts.$inferSelect
export type NewLoginAttempt = typeof loginAttempts.$inferInsert
