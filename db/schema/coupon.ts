import { boolean, index, integer, numeric, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { couponStatusEnum, couponTypeEnum } from './enums'
import { clientWechatUsers } from './user'
import { saleOrders } from './order'


export const couponTemplates = pgTable('coupon_templates', {
  templateId: text('template_id').primaryKey(),
  name: text('name').notNull(),
  couponType: couponTypeEnum('coupon_type').notNull(),
  
  discountValue: numeric('discount_value', { precision: 10, scale: 2 }).notNull(),
  
  minSpend: numeric('min_spend', { precision: 10, scale: 2 }).default('0'),
  
  maxDiscount: numeric('max_discount', { precision: 10, scale: 2 }),
  
  totalCount: integer('total_count'),
  
  applicableProductIds: text('applicable_product_ids').array(),
  
  applicableCategoryIds: text('applicable_category_ids').array(),
  
  applicableStoreIds: text('applicable_store_ids').array(),
  
  applicableMarketIds: text('applicable_market_ids').array(),
  
  validityMode: text('validity_mode').default('fixed'),
  
  validFrom: timestamp('valid_from', { withTimezone: true }),
  
  validTo: timestamp('valid_to', { withTimezone: true }),
  
  validDays: integer('valid_days'),
  description: text('description'),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`NOW()`),
})


export const userCoupons = pgTable(
  'user_coupons',
  {
    couponId: text('coupon_id').primaryKey(),
    templateId: text('template_id')
      .notNull()
      .references(() => couponTemplates.templateId),
    userId: text('user_id')
      .notNull()
      .references(() => clientWechatUsers.userId),
    status: couponStatusEnum('status').notNull().default('未使用'),
    
    expireAt: timestamp('expire_at', { withTimezone: true }).notNull(),
    
    faceValueOverride: numeric('face_value_override', { precision: 10, scale: 2 }),
    
    externalRef: text('external_ref'),
    
    usedSaleOrderId: varchar('used_sale_order_id', { length: 30 })
      .references(() => saleOrders.saleOrderId),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    index('idx_user_coupons_user_status').on(table.userId, table.status),
    index('idx_user_coupons_used_order').on(table.usedSaleOrderId),
    index('idx_user_coupons_expire').on(table.expireAt),
    uniqueIndex('uq_user_coupons_external_ref')
      .on(table.externalRef)
      .where(sql`external_ref IS NOT NULL`),
  ],
)

export type CouponTemplate = typeof couponTemplates.$inferSelect
export type NewCouponTemplate = typeof couponTemplates.$inferInsert
export type UserCoupon = typeof userCoupons.$inferSelect
export type NewUserCoupon = typeof userCoupons.$inferInsert
