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
 *
 * 父节点名称通过 JOIN parent_id 获取，不冗余存储。
 */
export const orgNodes = pgTable(
  'org_nodes',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    type: orgNodeTypeEnum('type').notNull(),
    parentId: text('parent_id').references((): any => orgNodes.id),
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
 * 业务表通过 store_id FK 关联 stores，市场名称通过 JOIN org_nodes 树获取。
 */
export const stores = pgTable(
  'stores',
  {
    storeId: text('store_id').primaryKey(),
    storeName: text('store_name').unique().notNull(),
    orgNodeId: text('org_node_id').references(() => orgNodes.id),
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
  ],
)

export type OrgNode = typeof orgNodes.$inferSelect
export type NewOrgNode = typeof orgNodes.$inferInsert
export type Store = typeof stores.$inferSelect
export type NewStore = typeof stores.$inferInsert
