import { pgTable, text, boolean, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/**
 * 拉卡拉收款商户档案（一店一商户的收款配置权威来源）。
 *
 * 进件流程已下线，本表收敛为纯收款配置：商户名 + 商户号 + 终端号 + 启用开关。
 * 门店通过 stores.lakala_merchant_id（N:1）关联本表；收款（clientApi resolveLakalaMerchant）
 * 与退款（admin refunds.ts）都从本表读 merchant_no / term_no / enabled。
 */
export const lakalaMerchants = pgTable(
  'lakala_merchants',
  {
    id: text('id').primaryKey(),
    /** 商户名称（区分各店商户的标识） */
    merchantName: text('merchant_name').notNull(),
    /** 拉卡拉商户号（收款必需） */
    merchantNo: text('merchant_no'),
    /** 终端号（收款必需） */
    termNo: text('term_no'),
    /** 启用真实支付通道；false 时走兜底不调拉卡拉 */
    enabled: boolean('enabled').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    // 部分唯一索引：merchant_no 非空时唯一，防止「商户管理」(/merchants) 重复建档；
    // 应用层 createMerchant/updateMerchant 亦做唯一校验，DB 约束作并发兜底。
    uniqueIndex('uq_lakala_merchants_merchant_no')
      .on(table.merchantNo)
      .where(sql`${table.merchantNo} IS NOT NULL`),
  ],
)

export type LakalaMerchant = typeof lakalaMerchants.$inferSelect
export type NewLakalaMerchant = typeof lakalaMerchants.$inferInsert
