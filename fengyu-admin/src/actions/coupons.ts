'use server'

import { db } from '@/db'
import { couponTemplates, userCoupons } from '@db/coupon'
import { eq, and, desc, gt, lte, or, isNull, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { CouponTemplate, AvailableCoupon } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'
import { calcCouponDiscount } from '@/lib/utils'

/**
 * 查询顾客在当前订单金额下可用的优惠券列表。
 * 过滤规则：未使用 + 未过期 + 模板启用 + 满足 minSpend + storeId 适用（if set）
 */
export async function getAvailableCoupons(
  clientUserId: string,
  totalAmount: number,
  storeId?: string,
): Promise<AvailableCoupon[]> {
  const session = await getSession()
  requirePermission(session, 'sale_order:create')

  const storeCondition = storeId
    ? or(
        isNull(couponTemplates.applicableStoreIds),
        sql`${storeId} = ANY(${couponTemplates.applicableStoreIds})`,
      )
    : isNull(couponTemplates.applicableStoreIds)

  const rows = await db
    .select({
      couponId: userCoupons.couponId,
      templateId: userCoupons.templateId,
      expireAt: userCoupons.expireAt,
      name: couponTemplates.name,
      couponType: couponTemplates.couponType,
      discountValue: couponTemplates.discountValue,
      minSpend: couponTemplates.minSpend,
      maxDiscount: couponTemplates.maxDiscount,
      applicableProductIds: couponTemplates.applicableProductIds,
      applicableCategoryIds: couponTemplates.applicableCategoryIds,
    })
    .from(userCoupons)
    .innerJoin(couponTemplates, eq(userCoupons.templateId, couponTemplates.templateId))
    .where(and(
      eq(userCoupons.userId, clientUserId),
      eq(userCoupons.status, '未使用'),
      gt(userCoupons.expireAt, new Date()),
      eq(couponTemplates.isActive, true),
      lte(sql`COALESCE(${couponTemplates.minSpend}, '0')::numeric`, totalAmount),
      storeCondition,
    ))
    .orderBy(userCoupons.expireAt)

  return rows.map((r) => {
    const discount = calcCouponDiscount(r.couponType, r.discountValue, r.maxDiscount ?? null, totalAmount)
    return {
      couponId: r.couponId,
      templateId: r.templateId,
      name: r.name,
      couponType: r.couponType as AvailableCoupon['couponType'],
      discountValue: r.discountValue,
      minSpend: r.minSpend ?? null,
      maxDiscount: r.maxDiscount ?? null,
      applicableProductIds: r.applicableProductIds ?? null,
      applicableCategoryIds: r.applicableCategoryIds ?? null,
      expireAt: r.expireAt.toISOString(),
      discountAmount: discount.toFixed(2),
    }
  })
}

function serializeTemplate(r: typeof couponTemplates.$inferSelect, issuedCount = 0): CouponTemplate {
  return {
    templateId: r.templateId,
    name: r.name,
    couponType: r.couponType as CouponTemplate['couponType'],
    discountValue: r.discountValue,
    minSpend: r.minSpend,
    maxDiscount: r.maxDiscount,
    totalCount: r.totalCount,
    issuedCount,
    applicableProductIds: r.applicableProductIds,
    applicableCategoryIds: r.applicableCategoryIds,
    applicableStoreIds: r.applicableStoreIds,
    validityMode: r.validityMode,
    validFrom: r.validFrom?.toISOString() ?? null,
    validTo: r.validTo?.toISOString() ?? null,
    validDays: r.validDays,
    description: r.description,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

export async function getTemplates(): Promise<CouponTemplate[]> {
  const session = await getSession()
  requirePermission(session, 'coupon:list')

  const rows = await db
    .select()
    .from(couponTemplates)
    .orderBy(desc(couponTemplates.createdAt))

  // 聚合每个模板的已发放数量（不受 status 过滤，反映总发放量）
  const counts = await db
    .select({
      templateId: userCoupons.templateId,
      issuedCount: sql<number>`COUNT(*)::int`,
    })
    .from(userCoupons)
    .groupBy(userCoupons.templateId)

  const countMap = new Map(counts.map((c) => [c.templateId, c.issuedCount]))

  return rows.map((r) => serializeTemplate(r, countMap.get(r.templateId) ?? 0))
}

export async function getTemplateById(templateId: string): Promise<CouponTemplate | null> {
  const session = await getSession()
  requirePermission(session, 'coupon:list')

  const rows = await db
    .select()
    .from(couponTemplates)
    .where(eq(couponTemplates.templateId, templateId))
    .limit(1)

  if (rows.length === 0) return null
  return serializeTemplate(rows[0])
}

export async function createTemplate(data: {
  templateId: string
  name: string
  couponType: string
  discountValue: string
  minSpend?: string
  maxDiscount?: string | null
  totalCount?: number | null
  applicableProductIds?: string[] | null
  applicableCategoryIds?: string[] | null
  applicableStoreIds?: string[] | null
  validityMode?: string
  validFrom?: string | null
  validTo?: string | null
  validDays?: number | null
  description?: string | null
  isActive?: boolean
}): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'coupon:create')

  // 校验券种类型
  const VALID_COUPON_TYPES = ['现金券', '项目券', '折扣券']
  if (!VALID_COUPON_TYPES.includes(data.couponType)) {
    return { success: false, message: `无效的券种类型: ${data.couponType}` }
  }

  // 校验 discountValue
  const dv = Number(data.discountValue)
  if (isNaN(dv) || dv <= 0) {
    return { success: false, message: '优惠值必须为正数' }
  }
  // 折扣券的 discountValue 必须在 (0, 1) 之间
  if (data.couponType === '折扣券' && (dv <= 0 || dv >= 1)) {
    return { success: false, message: '折扣券的折扣值必须在 0~1 之间（如 0.85 表示 85 折）' }
  }

  // 校验有效期顺序
  if (data.validFrom && data.validTo && new Date(data.validFrom) > new Date(data.validTo)) {
    return { success: false, message: '有效期开始日期不能晚于结束日期' }
  }

  try {
    await db.insert(couponTemplates).values({
      templateId: data.templateId,
      name: data.name,
      couponType: data.couponType as typeof couponTemplates.$inferInsert['couponType'],
      discountValue: data.discountValue,
      minSpend: data.minSpend,
      maxDiscount: data.maxDiscount ?? null,
      totalCount: data.totalCount ?? null,
      applicableProductIds: data.applicableProductIds ?? null,
      applicableCategoryIds: data.applicableCategoryIds ?? null,
      applicableStoreIds: data.applicableStoreIds ?? null,
      validityMode: data.validityMode as typeof couponTemplates.$inferInsert['validityMode'],
      validFrom: data.validFrom ? new Date(data.validFrom) : null,
      validTo: data.validTo ? new Date(data.validTo) : null,
      validDays: data.validDays ?? null,
      description: data.description ?? null,
      isActive: data.isActive ?? true,
    })
  } catch (err: any) {
    if (err?.code === '23505') {
      return { success: false, message: '优惠券模板编号已存在' }
    }
    throw err
  }

  await logOperation(session, 'coupon.create', 'coupon_template', data.templateId, { name: data.name })
  revalidatePath('/coupons')
  return { success: true, message: '优惠券模板创建成功' }
}

export async function updateTemplate(
  templateId: string,
  data: {
    name?: string
    couponType?: string
    discountValue?: string
    minSpend?: string
    maxDiscount?: string | null
    totalCount?: number | null
    applicableProductIds?: string[] | null
    applicableCategoryIds?: string[] | null
    applicableStoreIds?: string[] | null
    validityMode?: string
    validFrom?: string | null
    validTo?: string | null
    validDays?: number | null
    description?: string | null
    isActive?: boolean
  },
  /** 乐观锁：提交时携带的 updated_at */
  expectedUpdatedAt?: string,
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'coupon:update')

  const updateData: Record<string, unknown> = { ...data }
  if (data.validFrom !== undefined) {
    updateData.validFrom = data.validFrom ? new Date(data.validFrom) : null
  }
  if (data.validTo !== undefined) {
    updateData.validTo = data.validTo ? new Date(data.validTo) : null
  }

  const whereConditions = expectedUpdatedAt
    ? and(eq(couponTemplates.templateId, templateId), eq(couponTemplates.updatedAt, new Date(expectedUpdatedAt)))
    : eq(couponTemplates.templateId, templateId)

  let result: any
  try {
    result = await db
      .update(couponTemplates)
      .set(updateData)
      .where(whereConditions)
  } catch (err: any) {
    throw err
  }

  if ((result as any).rowCount === 0) {
    return {
      success: false,
      message: expectedUpdatedAt ? '数据已被其他人修改，请刷新后重试' : '优惠券模板不存在',
    }
  }

  await logOperation(session, 'coupon.update', 'coupon_template', templateId, data)
  revalidatePath('/coupons')
  return { success: true, message: '优惠券模板已更新' }
}

export async function toggleTemplateActive(
  templateId: string,
  isActive: boolean,
  /** 乐观锁：提交时携带的 updated_at */
  expectedUpdatedAt?: string,
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'coupon:update')

  const whereConditions = expectedUpdatedAt
    ? and(eq(couponTemplates.templateId, templateId), eq(couponTemplates.updatedAt, new Date(expectedUpdatedAt)))
    : eq(couponTemplates.templateId, templateId)

  let toggleResult: any
  try {
    toggleResult = await db
      .update(couponTemplates)
      .set({ isActive })
      .where(whereConditions)
  } catch (err: any) {
    throw err
  }

  if ((toggleResult as any).rowCount === 0) {
    return {
      success: false,
      message: expectedUpdatedAt ? '数据已被其他人修改，请刷新后重试' : '优惠券模板不存在',
    }
  }

  const action = isActive ? '启用' : '停用'
  await logOperation(session, `coupon.${action}`, 'coupon_template', templateId, { isActive })
  revalidatePath('/coupons')
  return { success: true, message: `优惠券模板已${action}` }
}
