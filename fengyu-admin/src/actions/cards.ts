'use server'

import { db } from '@/db'
import { saleItems, saleOrders } from '@db/order'
import { productSkus, productCategories } from '@db/product'
import { eq, and, or, sql } from 'drizzle-orm'
import { getSession } from '@/lib/auth'
import { requirePermission, isInScope } from '@/lib/permissions'

/**
 * 转换单候选卡 — 顾客在指定门店可折抵的购买行。
 *
 * 来源口径：sale_items 上 item_direction='购买'，且归属该顾客（通过 sale_orders
 * 反向 JOIN client_user_id）、归属指定 store_id；状态为"已支付/已完成"的订单。
 *
 * 两类折抵对象：
 *   1. 疗程卡 (product_type='疗程卡') AND remaining_sessions > 0
 *   2. 单品 (product_type='单品') AND product_category.product_kind='体验卡'
 *      AND quantity - COALESCE(picked_up_quantity,0) > 0
 *
 * 不包含：充值卡（走 prepaid_cards 账户，不在 sale_items 行）、院装产品（不在业务口径内）
 */
export interface HeldCardCandidate {
  saleItemId: string
  productName: string | null
  skuSpecName: string | null
  productType: '疗程卡' | '单品' | '院装产品'
  /** 剩余次数（疗程卡）；单品返回 null */
  remainingSessions: number | null
  /** 剩余可提货数量（单品）；疗程卡返回 null */
  remainingQty: number | null
  unitRealPrice: string
  /** 折抵金额 = unitRealPrice × (疗程卡:remainingSessions | 单品:remainingQty) */
  deductibleAmount: string
}

export async function getCustomerHeldCards(
  clientUserId: string,
  storeId: string,
): Promise<HeldCardCandidate[]> {
  const session = await getSession()
  requirePermission(session, 'sale_order:list')

  if (!clientUserId || !storeId) return []
  // scope 校验：admin 可全量，其余角色需 storeId 在 scope 内
  if (!isInScope(session, storeId)) return []

  const rows = await db
    .select({
      saleItemId: saleItems.saleItemId,
      productName: saleItems.productName,
      skuSpecName: saleItems.skuSpecName,
      productType: saleItems.productType,
      remainingSessions: saleItems.remainingSessions,
      quantity: saleItems.quantity,
      pickedUpQuantity: saleItems.pickedUpQuantity,
      unitRealPrice: saleItems.unitRealPrice,
      productKind: productCategories.productKind,
    })
    .from(saleItems)
    .innerJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
    .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
    .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
    .where(
      and(
        eq(saleItems.storeId, storeId),
        eq(saleOrders.clientUserId, clientUserId),
        eq(saleItems.itemDirection, '购买'),
        or(eq(saleOrders.status, '已支付'), eq(saleOrders.status, '已完成')),
        or(
          and(
            eq(saleItems.productType, '疗程卡'),
            sql`COALESCE(${saleItems.remainingSessions}, 0) > 0`,
          ),
          and(
            eq(saleItems.productType, '单品'),
            eq(productCategories.productKind, '体验卡'),
            sql`${saleItems.quantity} - COALESCE(${saleItems.pickedUpQuantity}, 0) > 0`,
          ),
        ),
      ),
    )

  return rows.map((r) => {
    const unit = Number(r.unitRealPrice)
    if (r.productType === '疗程卡') {
      const remSess = r.remainingSessions ?? 0
      return {
        saleItemId: r.saleItemId,
        productName: r.productName,
        skuSpecName: r.skuSpecName,
        productType: '疗程卡' as const,
        remainingSessions: remSess,
        remainingQty: null,
        unitRealPrice: r.unitRealPrice,
        deductibleAmount: (unit * remSess).toFixed(2),
      }
    }
    const remQty = r.quantity - (r.pickedUpQuantity ?? 0)
    return {
      saleItemId: r.saleItemId,
      productName: r.productName,
      skuSpecName: r.skuSpecName,
      productType: r.productType as HeldCardCandidate['productType'],
      remainingSessions: null,
      remainingQty: remQty,
      unitRealPrice: r.unitRealPrice,
      deductibleAmount: (unit * remQty).toFixed(2),
    }
  })
}
