import { boolean, date, index, integer, numeric, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { orgNodeTypeEnum } from "./enums";
import { lakalaMerchants } from "./lakala";


export const orgNodes = pgTable(
  "org_nodes",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: orgNodeTypeEnum("type").notNull(),
    parentId: text("parent_id").references((): any => orgNodes.id),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
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


export const stores = pgTable(
  "stores",
  {
    storeId: text("store_id").primaryKey(),
    storeName: text("store_name").unique().notNull(),
    
    orgNodeId: text("org_node_id")
      .references(() => orgNodes.id)
      .unique(),
    openingDate: date("opening_date"),
    bedCount: integer("bed_count"),
    isClosed: boolean("is_closed").notNull().default(false),
    
    closedAt: date("closed_at"),
    
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
    
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lakalaMerchantId: text("lakala_merchant_id").references((): any => lakalaMerchants.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
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
