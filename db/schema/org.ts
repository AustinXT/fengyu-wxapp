import { boolean, date, index, integer, numeric, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { orgNodeTypeEnum } from "./enums";
import { lakalaMerchants } from "./lakala";

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
  "org_nodes",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: orgNodeTypeEnum("type").notNull(),
    parentId: text("parent_id").references((): any => orgNodes.id),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    unique("uq_org_nodes_parent_name").on(table.parentId, table.name),
    index("idx_org_nodes_type").on(table.type),
    index("idx_org_nodes_parent_id").on(table.parentId),
  ],
);

/**
 * 门店详情（1:1 扩展 org_nodes type='store' 的节点）
 *
 * 业务表通过 store_id FK 关联 stores，市场名称通过 JOIN org_nodes 树获取。
 */
export const stores = pgTable(
  "stores",
  {
    storeId: text("store_id").primaryKey(),
    storeName: text("store_name").unique().notNull(),
    // 1:1 — 一个门店组织节点最多一条 stores 详情行（门店实体以组织树门店节点为权威）
    orgNodeId: text("org_node_id")
      .references(() => orgNodes.id)
      .unique(),
    openingDate: date("opening_date"),
    bedCount: integer("bed_count"),
    isClosed: boolean("is_closed").notNull().default(false),
    /** 闭店日期；NULL 表示在营。与 is_closed 双写一致（is_closed = closed_at IS NOT NULL） */
    closedAt: date("closed_at"),
    // 顾客向字段
    coverImage: text("cover_image"),
    images: text("images").array(),
    district: text("district"),
    streetAddress: text("street_address"),
    latitude: numeric("latitude", { precision: 10, scale: 7 }),
    longitude: numeric("longitude", { precision: 10, scale: 7 }),
    phone: text("phone"),
    businessHours: text("business_hours"),
    description: text("description"),
    announcement: text("announcement"),
    parkingInfo: text("parking_info"),
    // 拉卡拉收款配置已归位 lakala_merchants（merchant_no/term_no/enabled），本表仅留关联外键
    /**
     * 关联的拉卡拉收款商户（N:1，一个商户可对应多门店）；
     * ON UPDATE CASCADE / ON DELETE SET NULL：防孤悬，商户被硬删时关联自动清空。
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lakalaMerchantId: text("lakala_merchant_id").references((): any => lakalaMerchants.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    index("idx_stores_org_node_id").on(table.orgNodeId),
    index("idx_stores_lakala_merchant_id").on(table.lakalaMerchantId),
  ],
);

export type OrgNode = typeof orgNodes.$inferSelect;
export type NewOrgNode = typeof orgNodes.$inferInsert;
export type Store = typeof stores.$inferSelect;
export type NewStore = typeof stores.$inferInsert;
