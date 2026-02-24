import { date, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { serviceOrderStatusEnum } from './enums'
import { orderItems } from './order'
import { productSpuSkuMap } from './product'
import { clientWechatUsers } from './user'

/**
 * 实体三：护理单主表（对应 WorkFine UDT_S_259）
 *
 * 与订单的关联通过 service_items.item_flow_no → order_items.item_flow_no 实现，
 * 主表不存 order_no，支持同一次到店跨多笔订单核销（orders ↔ service_orders 为 N:N）。
 * 状态流转：待服务 -> 服务中 -> 已完成
 *   - 仅店长或 assigned_staff_wf_id 匹配的服务人员可推进状态
 *   - 仅在 服务中->已完成 时扣减 session_used 次，且不得小于 0
 *   - 重复点击完成时后端按同一服务单 ID 幂等处理，不得重复扣次
 */
export const serviceOrders = pgTable(
  'service_orders',
  {
    /** 主键，护理单编号，格式 HLD-WX-{YYMMDD}{序号} */
    serviceOrderNo: text('service_order_no').primaryKey(),
    status: serviceOrderStatusEnum('status').notNull().default('待服务'),
    /** 所属市场快照 */
    marketName: text('market_name').notNull(),
    /** 所属门店快照 */
    storeName: text('store_name').notNull(),
    serviceDate: date('service_date').notNull(),
    /** 服务时长（分钟） */
    serviceDuration: integer('service_duration'),
    /** 主责服务人员，关联 WorkFine UDT_S_287.UDF_S_1147，用于状态推进权限校验 */
    assignedStaffWfId: text('assigned_staff_wf_id').notNull(),
    remark: text('remark'),
    /**
     * 关联 client_wechat_users.user_id；
     * 员工开单时顾客可能未注册客户端小程序，允许为 null。
     */
    clientUserId: text('client_user_id').references(() => clientWechatUsers.userId),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_svc_orders_store_date').on(table.storeName, table.serviceDate),
    index('idx_svc_orders_assigned_staff').on(table.assignedStaffWfId),
  ],
)

/**
 * 实体三：护理明细（对应 WorkFine UDT_M_260）
 */
export const serviceItems = pgTable('service_items', {
  serviceItemId: text('service_item_id').primaryKey(),
  /** 关联 order_items.item_flow_no，核销锚点 */
  itemFlowNo: text('item_flow_no')
    .notNull()
    .references(() => orderItems.itemFlowNo),
  serviceOrderNo: text('service_order_no')
    .notNull()
    .references(() => serviceOrders.serviceOrderNo),
  skuId: text('sku_id').references(() => productSpuSkuMap.skuId),
  /** 本次划卡次数 */
  sessionUsed: integer('session_used').notNull(),
  /** 服务美容师，关联 WorkFine UDT_S_287.UDF_S_1147 */
  employeeId: text('employee_id').notNull(),
})

export type ServiceOrder = typeof serviceOrders.$inferSelect
export type NewServiceOrder = typeof serviceOrders.$inferInsert
export type ServiceItem = typeof serviceItems.$inferSelect
export type NewServiceItem = typeof serviceItems.$inferInsert
