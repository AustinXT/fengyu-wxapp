import { bigint, bigserial, check, index, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { clientWechatUsers } from './user'
import { saleOrders } from './order'

/**
 * 积分流水（审计源）+ 积分批次（可用余额源）
 *
 * 余额缓存已合并至 client_wechat_users.points_balance；引入 point_batches 后，
 * 可用余额以未过期批次 remaining_amount 之和为准，point_transactions 保留完整流水审计。
 * 会员等级（钻石等级）由 client_wechat_users.member_level 字段单独维护。
 *
 * bigint mode='number' 安全前提（migration 0028 升级 int4 → bigint）：
 *   - 单值 amount < 2^53（JS Number 精确范围），业务上限 << 2^53。
 *   - SUM 聚合理论可越过 2^53；当前业务体量（人均 < 1M 积分 × 百万顾客 ≈ 10^12）距 2^53 还有 4 个数量级。
 *   - 一旦业务量级跃迁逼近 2^53，必须切到 mode: 'bigint' + 业务层 BigInt 处理（pg 驱动 int8 默认回字符串）。
 *   - admin/src/actions/points.ts 的 SUM 聚合已配套 cast as bigint + safeNumber() 兜底 + safe-int 警告。
 */
export const pointTransactions = pgTable(
  'point_transactions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => clientWechatUsers.userId),
    type: text('type').notNull().default('获取'),
    /** 积分变动量 */
    amount: bigint('amount', { mode: 'number' }).notNull(),
    /** 关联订单ID（可选） */
    refOrderId: varchar('ref_order_id', { length: 30 }).references(() => saleOrders.saleOrderId),
    /** 外部幂等引用；批量权益及到店积分（日去重）使用，订单消费积分可为 null */
    externalRef: text('external_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_point_txns_user_id').on(table.userId),
    uniqueIndex('uq_point_txns_external_ref')
      .on(table.externalRef)
      .where(sql`external_ref IS NOT NULL`),
    /** 同订单同顾客同类型业务积分流水只能落 1 行：防 settlePoints / refund-cascade 双发 */
    uniqueIndex('uq_point_txn_order_user_type')
      .on(table.userId, table.refOrderId, table.type)
      .where(sql`ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销')`),
    // 半严格：已知负值 type ('消费冲销'/'消费抵扣'/'过期扣减') 严格守，正值兼容未来扩展（含'到店赠送'等）。
    // 禁 amount = 0（业务上零变动流水无意义）
    check(
      'chk_pt_amount_sign',
      sql`(${table.amount} < 0 AND ${table.type} IN ('消费冲销','消费抵扣','过期扣减')) OR ${table.amount} > 0`,
    ),
  ],
)

/**
 * 积分获得批次
 *
 * 每次正向获得积分生成一个批次，独立计算 365 天有效期。
 * 退款冲销、积分消费、过期扣减只减少 remaining_amount；流水仍写 point_transactions。
 */
export const pointBatches = pgTable(
  'point_batches',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => clientWechatUsers.userId),
    sourceTransactionId: bigint('source_transaction_id', { mode: 'number' })
      .notNull()
      .references(() => pointTransactions.id),
    sourceType: text('source_type').notNull(),
    refOrderId: varchar('ref_order_id', { length: 30 }).references(() => saleOrders.saleOrderId),
    originalAmount: bigint('original_amount', { mode: 'number' }).notNull(),
    remainingAmount: bigint('remaining_amount', { mode: 'number' }).notNull(),
    earnedAt: timestamp('earned_at', { withTimezone: true }).notNull(),
    expireAt: timestamp('expire_at', { withTimezone: true }).notNull(),
    expiredAt: timestamp('expired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    index('idx_point_batches_user_expire').on(table.userId, table.expireAt),
    index('idx_point_batches_ref_order').on(table.refOrderId).where(sql`ref_order_id IS NOT NULL`),
    index('idx_point_batches_source_txn').on(table.sourceTransactionId),
    check('chk_point_batches_original_positive', sql`${table.originalAmount} > 0`),
    check(
      'chk_point_batches_remaining_range',
      sql`${table.remainingAmount} >= 0 AND ${table.remainingAmount} <= ${table.originalAmount}`,
    ),
    check('chk_point_batches_expire_after_earned', sql`${table.expireAt} > ${table.earnedAt}`),
  ],
)

export type PointTransaction = typeof pointTransactions.$inferSelect
export type NewPointTransaction = typeof pointTransactions.$inferInsert
export type PointBatch = typeof pointBatches.$inferSelect
export type NewPointBatch = typeof pointBatches.$inferInsert
