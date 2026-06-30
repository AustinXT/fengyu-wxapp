import { pgTable, text, boolean, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgNodes } from './org'

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
    /**
     * 所属市场（指向 org_nodes type='市场' 节点）。admin 商户管理按此做市场 scope 过滤与筛选。
     * 可空：未分配市场的商户对非 admin 隐藏，admin 仍可见并补填。区别于 stores.org_node_id（门店节点）。
     * ON DELETE SET NULL：市场节点删除时清空关联，商户不跟随删除。
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    marketOrgNodeId: text('market_org_node_id').references((): any => orgNodes.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    // 部分唯一索引：merchant_no 非空时唯一，防止「商户管理」(/merchants) 重复建档；
    // 应用层 createMerchant/updateMerchant 亦做唯一校验，DB 约束作并发兜底。
    uniqueIndex('uq_lakala_merchants_merchant_no')
      .on(table.merchantNo)
      .where(sql`${table.merchantNo} IS NOT NULL`),
    // 市场 scope 过滤 / 市场筛选用
    index('idx_lakala_merchants_market_org_node_id').on(table.marketOrgNodeId),
  ],
)

export type LakalaMerchant = typeof lakalaMerchants.$inferSelect
export type NewLakalaMerchant = typeof lakalaMerchants.$inferInsert
