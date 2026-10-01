import { boolean, date, index, integer, numeric, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { allocationStatusEnum, salesCategoryEnum, serviceOrderStatusEnum, serviceOrderTypeEnum } from './enums'
import { stores } from './org'
import { saleItems } from './order'
import { clientWechatUsers, staffWechatUsers } from './user'
import { appointments } from './appointment'

/**
 * 服务单主表
 *
 * 与订单的关联通过 service_items.sale_item_id → sale_items.sale_item_id 实现，
 * 主表不存 sale_order_id，支持同一次到店跨多笔订单核销。
 * 状态流转：待服务 -> 服务中 -> 待客户确认 -> 已完成
 * 员工点「完成」仅把 服务中 -> 待客户确认（记 staff_completed_at），不产生副作用；
 * 顾客（或店长/后台代）确认后才 待客户确认 -> 已完成，并原子扣减次数 + 计提成 + 关预约（记 completed_at）。
 */
export const serviceOrders = pgTable(
  'service_orders',
  {
    serviceOrderId: varchar('service_order_id', { length: 30 }).primaryKey(),
    status: serviceOrderStatusEnum('status').notNull().default('待服务'),
    serviceOrderType: serviceOrderTypeEnum('service_order_type').notNull().default('售前'),
    /** 所属市场（快照） */
    marketName: varchar('market_name', { length: 100 }).notNull(),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.storeId),
    serviceDate: date('service_date').notNull(),
    assignedEmployeeId: varchar('assigned_employee_id', { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    remark: text('remark'),
    appointmentId: text('appointment_id').references(() => appointments.appointmentId),
    clientUserId: text('client_user_id').references(() => clientWechatUsers.userId),
    /** 服务开始时间（状态转为"服务中"时记录） */
    startedAt: timestamp('started_at', { withTimezone: true }),
    /** 员工标记完成时间（状态转为"待客户确认"时记录） */
    staffCompletedAt: timestamp('staff_completed_at', { withTimezone: true }),
    /** 服务完成时间（顾客/代确认使状态转为"已完成"时记录） */
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** 提成分配状态（仅已完成的服务单有值） */
    commissionStatus: allocationStatusEnum('commission_status'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    index('idx_svc_orders_store_date').on(table.storeId, table.serviceDate),
    index('idx_svc_orders_assigned_employee').on(table.assignedEmployeeId),
    index('idx_svc_orders_client_user_id').on(table.clientUserId),
    /**
     * 服务单列表默认排序 + 状态筛选支撑索引。
     * Why: admin allocations「服务提成」Tab 与 services 列表均走
     *   `WHERE status=? ORDER BY updated_at DESC, created_at DESC LIMIT N`，
     *   '已完成' 行占全表 ~100%，缺索引会全表 Parallel Seq Scan + top-N heapsort（实测 163ms/20 行）。
     *   加该复合索引后变为 Index Scan + LIMIT 早终止。
     * NULLS FIRST 必填：SQL 标准 `ORDER BY x DESC` 默认 NULLS FIRST；
     *   Drizzle `.desc()` 生成 `DESC NULLS LAST` 与之不匹配，PG 不会用索引顺序。
     */
    index('idx_svc_orders_status_updated').on(
      table.status,
      table.updatedAt.desc().nullsFirst(),
      table.createdAt.desc().nullsFirst(),
    ),
    /** 同一预约只能关联 1 张服务单：防 TOCTOU 双 staff 同 appointmentId 同时 create */
    uniqueIndex('uq_so_appointment')
      .on(table.appointmentId)
      .where(sql`appointment_id IS NOT NULL`),
    /**
     * 同一顾客同时只能有 1 张活跃服务单：防同顾客双 create（待客户确认 仍占活跃，未确认期间不能开新服务单）。
     * 谓词用 NOT IN 终态而非正列表：仅引用既有枚举值，避免与 ALTER TYPE ADD VALUE '待客户确认'
     * 同事务时触发 55P04（drizzle migrate 把全部 pending migration 包进单事务），同时天然涵盖未来新增的非终态。
     */
    uniqueIndex('uq_so_client_active')
      .on(table.clientUserId)
      .where(sql`status NOT IN ('已完成','已取消')`),
  ],
)

/**
 * 服务明细
 */
export const serviceItems = pgTable(
  'service_items',
  {
    serviceItemId: text('service_item_id').primaryKey(),
    saleItemId: varchar('sale_item_id', { length: 30 })
      .notNull()
      .references(() => saleItems.saleItemId),
    /** sale_items.unit_real_price 快照（per-session 单次优惠后价；提成 per_session 直接取此值，无需再 ÷session_count） */
    unitRealPrice: numeric('unit_real_price', { precision: 10, scale: 2 }),
    /** 生美标记快照：服务单创建时取 product_skus.is_shengmei 当前值，SKU 为 NULL 时回退 sale_items.is_shengmei（#378） */
    isShengmei: boolean('is_shengmei'),
    /** sale_items.sales_category 快照（从 sale_items 拷贝，用于"项目数"等口径统计） */
    salesCategory: salesCategoryEnum('sales_category'),
    serviceOrderId: varchar('service_order_id', { length: 30 })
      .notNull()
      .references(() => serviceOrders.serviceOrderId),
    sessionUsed: integer('session_used').notNull(),
    employeeId: varchar('employee_id', { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    /** 服务时长（分钟） */
    serviceDuration: integer('service_duration'),
    /** 预扣时间戳（服务开始时记录，用于防止服务期间疗程卡被转换单/退款消耗；NULL=未预扣，NOT NULL=已预扣） */
    reservedAt: timestamp('reserved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    index('idx_svc_items_order_id').on(table.serviceOrderId),
    /** 转换单/退款查询预扣统计时需要；WHERE 过滤减少索引大小（已完成服务单的 reserved_at 会被清除为 NULL） */
    index('idx_svc_items_sale_item_reserved').on(table.saleItemId).where(sql`${table.reservedAt} IS NOT NULL`),
  ],
)

/**
 * 服务评价（顾客对已完成服务单的美容师评价）
 *
 * 一单一评：service_order_id 作 PK，天然唯一约束，重复评价由 PG 23505 拦截。
 * employee_id 取服务单 assigned_employee_id 快照，便于按美容师聚合平均分。
 * 客户端入口在 service-records 列表（仅"已完成"服务单可评价），提交后不可改。
 */
export const serviceReviews = pgTable(
  'service_reviews',
  {
    serviceOrderId: varchar('service_order_id', { length: 30 })
      .primaryKey()
      .references(() => serviceOrders.serviceOrderId),
    /** 被评价美容师（= 服务单 assigned_employee_id 快照） */
    employeeId: varchar('employee_id', { length: 30 })
      .notNull()
      .references(() => staffWechatUsers.employeeId),
    /** 评价人 */
    clientUserId: text('client_user_id')
      .notNull()
      .references(() => clientWechatUsers.userId),
    /** 星级 1–5，应用层校验为整数 */
    rating: integer('rating').notNull(),
    /** 评价文字内容，选填 */
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** 支撑按美容师聚合 avg(rating)/count 的列表与详情展示 */
    index('idx_svc_reviews_employee').on(table.employeeId),
  ],
)

export type ServiceOrder = typeof serviceOrders.$inferSelect
export type NewServiceOrder = typeof serviceOrders.$inferInsert
export type ServiceItem = typeof serviceItems.$inferSelect
export type NewServiceItem = typeof serviceItems.$inferInsert
export type ServiceReview = typeof serviceReviews.$inferSelect
export type NewServiceReview = typeof serviceReviews.$inferInsert
