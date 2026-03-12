import { boolean, date, index, integer, numeric, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core'
import { orgNodeTypeEnum } from './enums'

/**
 * 组织架构树（邻接表）
 *
 * 层级约束（应用层校验）：
 * | 节点类型       | parent 必须是                            |
 * |---------------|------------------------------------------|
 * | headquarters  | NULL（根节点）                             |
 * | market        | headquarters                             |
 * | store         | market                                   |
 * | department    | headquarters / market / store（不能挂 department） |
 */
export const orgNodes = pgTable(
  'org_nodes',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    type: orgNodeTypeEnum('type').notNull(),
    parentId: text('parent_id').references((): any => orgNodes.id),
    /** 冗余父节点名称，避免查询时 JOIN 自身 */
    parentName: text('parent_name'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    unique('uq_org_nodes_parent_name').on(table.parentId, table.name),
    index('idx_org_nodes_type').on(table.type),
    index('idx_org_nodes_parent_id').on(table.parentId),
  ],
)

/**
 * 门店详情（1:1 扩展 org_nodes type='store' 的节点）
 *
 * store_name UNIQUE 继续作为业务主键，现有 orders.store_name 等快照字段不变。
 * market_name 冗余保留：避免每次 JOIN 查父节点，兼容现有订单快照写入逻辑。
 */
export const stores = pgTable(
  'stores',
  {
    storeId: text('store_id').primaryKey(),
    storeName: text('store_name').unique().notNull(),
    orgNodeId: text('org_node_id').references(() => orgNodes.id),
    marketName: text('market_name').notNull(),
    openingDate: date('opening_date'),
    bedCount: integer('bed_count'),
    isClosed: boolean('is_closed').notNull().default(false),
    // 顾客向字段
    coverImage: text('cover_image'),
    images: text('images').array(),
    district: text('district'),
    streetAddress: text('street_address'),
    latitude: numeric('latitude', { precision: 10, scale: 7 }),
    longitude: numeric('longitude', { precision: 10, scale: 7 }),
    phone: text('phone'),
    businessHours: text('business_hours'),
    description: text('description'),
    announcement: text('announcement'),
    parkingInfo: text('parking_info'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    index('idx_stores_org_node_id').on(table.orgNodeId),
    index('idx_stores_market_name').on(table.marketName),
  ],
)

export type OrgNode = typeof orgNodes.$inferSelect
export type NewOrgNode = typeof orgNodes.$inferInsert
export type Store = typeof stores.$inferSelect
export type NewStore = typeof stores.$inferInsert
