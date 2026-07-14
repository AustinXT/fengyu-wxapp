'use server'

import { db } from '@/db'
import { pgErrorCode } from '@/lib/pg-error'
import { couponTemplates, userCoupons } from '@db/coupon'
import { clientWechatUsers } from '@db/user'
import { orgNodes, stores } from '@db/org'
import { productCategories, productSkus } from '@db/product'
import { eq, and, desc, gt, lte, or, isNull, isNotNull, sql, asc, ilike, inArray } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { CouponTemplate, AvailableCoupon, IssuedCoupon, BatchCouponCustomer, OrgNode } from '@/lib/types'
import { withPermission } from '@/lib/with-permission'
import { expandVisibleMarketIds } from '@/lib/permissions'
import { logOperation, logTransition, logUpdate } from '@/lib/operation-log'
import { calcCouponDiscount } from '@/lib/utils'
import { beijingTs, nowTs } from '@/lib/db-time'
import { fmtDate } from '@/lib/datetime'


function validBoundTs(value: string | Date, time: '00:00:00' | '23:59:59') {
  return sql`${`${fmtDate(value)} ${time}`}::timestamp AT TIME ZONE 'Asia/Shanghai'`
}


function validateValidityFields(merged: {
  validityMode?: string | null
  validDays?: number | null
  validFrom?: string | Date | null
  validTo?: string | Date | null
}): { ok: true } | { ok: false; message: string } {
  if (merged.validityMode !== 'days' && merged.validityMode !== 'fixed') {
    return { ok: false, message: '有效期模式必须为 days 或 fixed' }
  }
  if (merged.validityMode === 'days') {
    const vd = Number(merged.validDays)
    if (!Number.isInteger(vd) || vd <= 0) {
      return { ok: false, message: '"领取后 N 天"模式需填写正整数有效天数' }
    }
    if (vd > 3650) {
      return { ok: false, message: '有效天数不能超过 3650 天（10 年）' }
    }
  }
  if (merged.validityMode === 'fixed') {
    if (!merged.validFrom || !merged.validTo) {
      return { ok: false, message: '"固定时段"模式需同时填写开始与结束日期' }
    }
    
    
    
    const toBeijingDate = (v: string | Date): string =>
      v instanceof Date
        ? new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(v)
        : v.slice(0, 10)
    const fromDate = toBeijingDate(merged.validFrom)
    const toDate = toBeijingDate(merged.validTo)
    const fromStart = new Date(`${fromDate}T00:00:00+08:00`)
    const toEnd = new Date(`${toDate}T23:59:59+08:00`)
    if (Number.isNaN(fromStart.getTime()) || Number.isNaN(toEnd.getTime())) {
      return { ok: false, message: '"固定时段"模式需同时填写开始与结束日期' }
    }
    if (fromDate >= toDate) {
      return { ok: false, message: '有效期开始日期必须早于结束日期' }
    }
    if (toEnd <= new Date()) {
      return { ok: false, message: '有效期结束日期必须晚于当前时间' }
    }
  }
  return { ok: true }
}


export const getMarkets = withPermission(
  'coupon:list',
  async (session): Promise<{ id: string; name: string }[]> => {
    const visibleIds = await expandVisibleMarketIds(session)
    if (visibleIds !== null && visibleIds.length === 0) return []

    const scopeCond = visibleIds === null ? undefined : inArray(orgNodes.id, visibleIds)
    const rows = await db
      .select({ id: orgNodes.id, name: orgNodes.name })
      .from(orgNodes)
      .where(and(eq(orgNodes.type, '市场'), eq(orgNodes.isActive, true), scopeCond))
      
      .orderBy(asc(orgNodes.sortOrder))

    return rows
  },
)


export const getCategoriesForCoupon = withPermission(
  'coupon:list',
  async (_session): Promise<{ categoryId: string; categoryName: string; productKind: string | null }[]> => {
    const rows = await db
      .select({
        categoryId: productCategories.categoryId,
        categoryName: productCategories.categoryName,
        productKind: productCategories.productKind,
      })
      .from(productCategories)
      .where(eq(productCategories.isValid, true))
      
      .orderBy(asc(productCategories.sortOrder))

    return rows.map((r) => ({
      categoryId: r.categoryId,
      categoryName: r.categoryName,
      productKind: r.productKind,
    }))
  },
)


export const getAvailableCoupons = withPermission(
  'sale_order:create',
  async (
    _session,
    clientUserId: string,
    totalAmount: number,
    storeId?: string,
    items?: { skuId: string; amount: number }[],
  ): Promise<AvailableCoupon[]> => {
    
    
    const totalRaw = Number(totalAmount)
    if (!Number.isFinite(totalRaw) || totalRaw < 0) {
      throw new Error('INVALID_PARAMS: totalAmount 参数非法')
    }
    const total = Math.round(totalRaw * 100) / 100

    const storeCondition = storeId
      ? or(
          isNull(couponTemplates.applicableStoreIds),
          sql`${storeId} = ANY(${couponTemplates.applicableStoreIds})`,
        )
      : isNull(couponTemplates.applicableStoreIds)

    
    let marketCondition
    if (storeId) {
      
      const storeRow = await db
        .select({ parentId: orgNodes.parentId })
        .from(stores)
        .innerJoin(orgNodes, eq(stores.orgNodeId, orgNodes.id))
        .where(eq(stores.storeId, storeId))
        .limit(1)
      const marketId = storeRow[0]?.parentId
      marketCondition = marketId
        ? or(
            isNull(couponTemplates.applicableMarketIds),
            sql`${marketId} = ANY(${couponTemplates.applicableMarketIds})`,
          )
        : isNull(couponTemplates.applicableMarketIds)
    } else {
      marketCondition = isNull(couponTemplates.applicableMarketIds)
    }

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
        gt(userCoupons.expireAt, nowTs()),
        eq(couponTemplates.isActive, true),
        
        storeCondition,
        marketCondition,
      ))
      
      .orderBy(asc(userCoupons.expireAt))

    
    let skuCatMap: Map<string, string | null> | null = null
    if (items && items.length > 0) {
      const skuRows = await db
        .select({ skuId: productSkus.skuId, categoryId: productSkus.categoryId })
        .from(productSkus)
        .where(and(inArray(productSkus.skuId, items.map((i) => i.skuId)), isNull(productSkus.deletedAt)))
      skuCatMap = new Map(skuRows.map((r) => [r.skuId, r.categoryId]))
    }

    return rows.flatMap((r) => {
      
      let eligibleTotal = total
      if (skuCatMap && items) {
        const cats = r.applicableCategoryIds
        const eligibleItems =
          cats && cats.length > 0
            ? items.filter((it) => cats.includes(skuCatMap!.get(it.skuId) ?? ''))
            : items
        if (eligibleItems.length === 0) return [] 
        eligibleTotal = Math.round(eligibleItems.reduce((s, it) => s + Number(it.amount || 0), 0) * 100) / 100
      }
      const minSpend = Math.round((Number(r.minSpend) || 0) * 100) / 100
      if (eligibleTotal + 0.001 < minSpend) return [] 
      const discount = calcCouponDiscount(r.couponType, r.discountValue, r.maxDiscount ?? null, eligibleTotal)
      return [{
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
      }]
    })
  },
)

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
    applicableMarketIds: r.applicableMarketIds,
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

export const getTemplates = withPermission(
  'coupon:list',
  async (_session): Promise<CouponTemplate[]> => {
    const rows = await db
      .select()
      .from(couponTemplates)
      
      .orderBy(desc(couponTemplates.updatedAt), desc(couponTemplates.createdAt))
      .limit(500)

    
    const counts = await db
      .select({
        templateId: userCoupons.templateId,
        issuedCount: sql<number>`COUNT(*)::int`,
      })
      .from(userCoupons)
      .groupBy(userCoupons.templateId)

    const countMap = new Map(counts.map((c) => [c.templateId, c.issuedCount]))

    return rows.map((r) => serializeTemplate(r, countMap.get(r.templateId) ?? 0))
  },
)

export const getTemplateById = withPermission(
  'coupon:list',
  async (_session, templateId: string): Promise<CouponTemplate | null> => {
    const rows = await db
      .select()
      .from(couponTemplates)
      .where(eq(couponTemplates.templateId, templateId))
      .limit(1)

    if (rows.length === 0) return null
    return serializeTemplate(rows[0])
  },
)

export const createTemplate = withPermission(
  'coupon:create',
  async (
    session,
    data: {
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
      applicableMarketIds?: string[] | null
      validityMode: 'days' | 'fixed'
      validFrom?: string | null
      validTo?: string | null
      validDays?: number | null
      description?: string | null
      isActive?: boolean
    },
  ): Promise<{ success: boolean; message: string }> => {
    
    const VALID_COUPON_TYPES = ['现金券', '品项券', '折扣券']
    if (!VALID_COUPON_TYPES.includes(data.couponType)) {
      return { success: false, message: `无效的券种类型: ${data.couponType}` }
    }

    
    const dv = Number(data.discountValue)
    if (isNaN(dv) || dv <= 0) {
      return { success: false, message: '优惠值必须为正数' }
    }
    
    if (data.couponType === '折扣券' && (dv <= 0 || dv >= 1)) {
      return { success: false, message: '折扣券的折扣值必须在 0~1 之间（如 0.85 表示 85 折）' }
    }

    
    const validityCheck = validateValidityFields({
      validityMode: data.validityMode,
      validDays: data.validDays ?? null,
      validFrom: data.validFrom ?? null,
      validTo: data.validTo ?? null,
    })
    if (!validityCheck.ok) {
      return { success: false, message: validityCheck.message }
    }

    
    const isDays = data.validityMode === 'days'
    const insertValidFrom = isDays ? null : (data.validFrom ? validBoundTs(data.validFrom, '00:00:00') : null)
    const insertValidTo = isDays ? null : (data.validTo ? validBoundTs(data.validTo, '23:59:59') : null)
    const insertValidDays = isDays ? (data.validDays ?? null) : null

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
        applicableMarketIds: data.applicableMarketIds ?? null,
        validityMode: data.validityMode as typeof couponTemplates.$inferInsert['validityMode'],
        validFrom: insertValidFrom,
        validTo: insertValidTo,
        validDays: insertValidDays,
        description: data.description ?? null,
        isActive: data.isActive ?? true,
      })
    } catch (err: any) {
      if (pgErrorCode(err) === '23505') {
        return { success: false, message: '优惠券模板编号已存在' }
      }
      throw err
    }

    await logOperation(session, 'coupon.create', 'coupon_template', data.templateId, { name: data.name })
    revalidatePath('/coupons')
    return { success: true, message: '优惠券模板创建成功' }
  },
)

export const updateTemplate = withPermission(
  'coupon:update',
  async (
    session,
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
      applicableMarketIds?: string[] | null
      validityMode?: string
      validFrom?: string | null
      validTo?: string | null
      validDays?: number | null
      description?: string | null
      isActive?: boolean
    },
    
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
    
    const [before] = await db.select().from(couponTemplates).where(eq(couponTemplates.templateId, templateId)).limit(1)

    if (!before) {
      return { success: false, message: '优惠券模板不存在' }
    }

    
    const patchTouchesValidity =
      data.validityMode !== undefined ||
      data.validDays !== undefined ||
      data.validFrom !== undefined ||
      data.validTo !== undefined

    const updateData: Record<string, unknown> = { ...data }

    if (patchTouchesValidity) {
      
      const nextMode = data.validityMode !== undefined ? data.validityMode : (before as any).validityMode
      const modeSwitched = data.validityMode !== undefined && data.validityMode !== (before as any).validityMode

      if (modeSwitched && nextMode === 'days') {
        if (data.validDays === undefined) {
          return { success: false, message: '切换到"领取后 N 天"模式需同时提交有效天数' }
        }
      }
      if (modeSwitched && nextMode === 'fixed') {
        if (data.validFrom === undefined || data.validTo === undefined) {
          return { success: false, message: '切换到"固定时段"模式需同时提交开始与结束日期' }
        }
      }

      
      const merged = {
        validityMode: data.validityMode !== undefined ? data.validityMode : (before as any).validityMode,
        validDays: data.validDays !== undefined ? data.validDays : (before as any).validDays,
        validFrom: data.validFrom !== undefined
          ? (data.validFrom ? new Date(data.validFrom) : null)
          : (before as any).validFrom,
        validTo: data.validTo !== undefined
          ? (data.validTo ? new Date(data.validTo) : null)
          : (before as any).validTo,
      }

      const validityCheck = validateValidityFields(merged)
      if (!validityCheck.ok) {
        return { success: false, message: validityCheck.message }
      }

      
      if (merged.validityMode === 'days') {
        updateData.validFrom = null
        updateData.validTo = null
        updateData.validDays = merged.validDays
      } else {
        updateData.validDays = null
        
        
        const fromSrc = data.validFrom !== undefined ? data.validFrom : (before as any).validFrom
        const toSrc = data.validTo !== undefined ? data.validTo : (before as any).validTo
        updateData.validFrom = fromSrc ? validBoundTs(fromSrc, '00:00:00') : null
        updateData.validTo = toSrc ? validBoundTs(toSrc, '23:59:59') : null
      }
    } else {
      
      if (data.validFrom !== undefined) {
        updateData.validFrom = data.validFrom ? validBoundTs(data.validFrom, '00:00:00') : null
      }
      if (data.validTo !== undefined) {
        updateData.validTo = data.validTo ? validBoundTs(data.validTo, '23:59:59') : null
      }
    }

    const whereConditions = expectedUpdatedAt
      ? and(eq(couponTemplates.templateId, templateId), sql`date_trunc('milliseconds', ${couponTemplates.updatedAt}) = ${expectedUpdatedAt}`)
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

    if ((result as any).count === 0) {
      return {
        success: false,
        message: expectedUpdatedAt ? '数据已被其他人修改，请刷新后重试' : '优惠券模板不存在',
      }
    }

    await logUpdate(session, 'coupon.update', 'coupon_template', templateId, before as Record<string, unknown>, data)
    revalidatePath('/coupons')
    return { success: true, message: '优惠券模板已更新' }
  },
)

export const toggleTemplateActive = withPermission(
  'coupon:update',
  async (
    session,
    templateId: string,
    isActive: boolean,
    
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
    const whereConditions = expectedUpdatedAt
      ? and(eq(couponTemplates.templateId, templateId), sql`date_trunc('milliseconds', ${couponTemplates.updatedAt}) = ${expectedUpdatedAt}`)
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

    if ((toggleResult as any).count === 0) {
      return {
        success: false,
        message: expectedUpdatedAt ? '数据已被其他人修改，请刷新后重试' : '优惠券模板不存在',
      }
    }

    const actionLabel = isActive ? '启用' : '停用'
    await logTransition(session, `coupon.${actionLabel}`, 'coupon_template', templateId,
      isActive ? '停用' : '启用', actionLabel,
    )
    revalidatePath('/coupons')
    return { success: true, message: `优惠券模板已${actionLabel}` }
  },
)


export const issueCoupon = withPermission(
  'coupon:create',
  async (
    session,
    templateId: string,
    phone: string,
  ): Promise<{ success: boolean; message: string }> => {
    
    const [tpl] = await db
      .select()
      .from(couponTemplates)
      .where(eq(couponTemplates.templateId, templateId))
      .limit(1)

    if (!tpl) return { success: false, message: '优惠券模板不存在' }
    if (!tpl.isActive) return { success: false, message: '该模板已停用，无法发放' }

    
    if (tpl.totalCount !== null) {
      const [{ count }] = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(userCoupons)
        .where(eq(userCoupons.templateId, templateId))

      if (count >= tpl.totalCount) {
        return { success: false, message: `发放数量已达上限（${tpl.totalCount}）` }
      }
    }

    
    const [customer] = await db
      .select({ userId: clientWechatUsers.userId, name: clientWechatUsers.name })
      .from(clientWechatUsers)
      .where(eq(clientWechatUsers.phone, phone))
      .limit(1)

    if (!customer) return { success: false, message: '未找到该手机号对应的顾客' }

    
    let expireAt: SQL
    if (tpl.validityMode === 'days' && tpl.validDays) {
      const d = new Date()
      d.setDate(d.getDate() + tpl.validDays)
      expireAt = beijingTs(d)
    } else if (tpl.validityMode === 'fixed' && tpl.validTo) {
      expireAt = beijingTs(new Date(tpl.validTo))
    } else {
      console.error('[issueCoupon] INVALID_TEMPLATE', {
        templateId: tpl.templateId, validityMode: tpl.validityMode,
        validDays: tpl.validDays, validTo: tpl.validTo,
      })
      return { success: false, message: '优惠券模板有效期配置异常，请联系管理员修复后再发放' }
    }

    
    const couponId = `cpn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    await db.insert(userCoupons).values({
      couponId,
      templateId,
      userId: customer.userId,
      status: '未使用',
      expireAt,
    })

    await logOperation(session, 'coupon.issue', 'user_coupon', couponId, {
      templateId,
      templateName: tpl.name,
      customerPhone: phone,
      customerName: customer.name,
    })

    revalidatePath(`/coupons/${templateId}`)
    return { success: true, message: `已成功向 ${customer.name || phone} 发放优惠券` }
  },
)


export const getIssuedCoupons = withPermission(
  'coupon:list',
  async (_session, templateId: string): Promise<IssuedCoupon[]> => {
    const rows = await db
      .select({
        couponId: userCoupons.couponId,
        customerName: clientWechatUsers.name,
        phone: clientWechatUsers.phone,
        status: userCoupons.status,
        issuedAt: userCoupons.createdAt,
        usedAt: userCoupons.usedAt,
      })
      .from(userCoupons)
      .innerJoin(clientWechatUsers, eq(userCoupons.userId, clientWechatUsers.userId))
      .where(eq(userCoupons.templateId, templateId))
      
      .orderBy(desc(userCoupons.createdAt))
      .limit(500)

    return rows.map((r) => ({
      couponId: r.couponId,
      customerName: r.customerName || '未知',
      phone: r.phone || '',
      status: r.status as IssuedCoupon['status'],
      issuedAt: r.issuedAt.toISOString(),
      usedAt: r.usedAt?.toISOString() ?? null,
    }))
  },
)


export const batchIssueCoupons = withPermission(
  'coupon:create',
  async (
    session,
    templateId: string,
    phones: string[],
  ): Promise<{
    success: boolean
    message: string
    errors?: Array<{ phone: string; reason: string }>
  }> => {
    
    const uniquePhones = [...new Set(phones.map((p) => p.trim()).filter(Boolean))]
    if (uniquePhones.length === 0) {
      return { success: false, message: '请输入至少一个手机号' }
    }
    if (uniquePhones.length > 200) {
      return { success: false, message: '单次批量发放不能超过 200 个手机号' }
    }

    
    const [tpl] = await db
      .select()
      .from(couponTemplates)
      .where(eq(couponTemplates.templateId, templateId))
      .limit(1)

    if (!tpl) return { success: false, message: '优惠券模板不存在' }
    if (!tpl.isActive) return { success: false, message: '该模板已停用，无法发放' }

    
    if (tpl.totalCount !== null) {
      const [{ count }] = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(userCoupons)
        .where(eq(userCoupons.templateId, templateId))

      const remaining = tpl.totalCount - count
      if (remaining < uniquePhones.length) {
        return {
          success: false,
          message: `发放数量不足：剩余额度 ${remaining} 张，请求 ${uniquePhones.length} 张`,
        }
      }
    }

    
    const customers = await db
      .select({ userId: clientWechatUsers.userId, name: clientWechatUsers.name, phone: clientWechatUsers.phone })
      .from(clientWechatUsers)
      .where(inArray(clientWechatUsers.phone, uniquePhones))

    const customerMap = new Map(customers.map((c) => [c.phone!, { userId: c.userId, name: c.name }]))

    
    const errors: Array<{ phone: string; reason: string }> = []
    for (const phone of uniquePhones) {
      if (!customerMap.has(phone)) {
        errors.push({ phone, reason: '未找到该手机号对应的顾客' })
      }
    }
    if (errors.length > 0) {
      return { success: false, message: `有 ${errors.length} 个手机号未匹配到顾客`, errors }
    }

    
    let expireAt: SQL
    if (tpl.validityMode === 'days' && tpl.validDays) {
      const d = new Date()
      d.setDate(d.getDate() + tpl.validDays)
      expireAt = beijingTs(d)
    } else if (tpl.validityMode === 'fixed' && tpl.validTo) {
      expireAt = beijingTs(new Date(tpl.validTo))
    } else {
      console.error('[batchIssueCoupons] INVALID_TEMPLATE', {
        templateId: tpl.templateId, validityMode: tpl.validityMode,
        validDays: tpl.validDays, validTo: tpl.validTo,
      })
      return { success: false, message: '优惠券模板有效期配置异常，请联系管理员修复后再发放' }
    }

    
    const now = Date.now()
    const values = uniquePhones.map((phone, i) => {
      const customer = customerMap.get(phone)!
      return {
        couponId: `cpn-${now}-${Math.random().toString(36).slice(2, 6)}-${i}`,
        templateId,
        userId: customer.userId,
        status: '未使用' as const,
        expireAt,
      }
    })

    await db.insert(userCoupons).values(values)

    
    await logOperation(session, 'coupon.batchIssue', 'coupon_template', templateId, {
      templateName: tpl.name,
      count: uniquePhones.length,
      phones: uniquePhones,
    })

    revalidatePath(`/coupons/${templateId}`)
    return { success: true, message: `已成功向 ${uniquePhones.length} 位顾客批量发放优惠券` }
  },
)


async function resolveOrgNodeToStoreIds(orgNodeId: string): Promise<string[] | null> {
  const [node] = await db
    .select({ type: orgNodes.type, parentId: orgNodes.parentId })
    .from(orgNodes)
    .where(eq(orgNodes.id, orgNodeId))
    .limit(1)

  if (!node) return null

  if (node.type === '总部') return null

  if (node.type === '门店') {
    const [store] = await db
      .select({ storeId: stores.storeId })
      .from(stores)
      .where(eq(stores.orgNodeId, orgNodeId))
      .limit(1)
    return store ? [store.storeId] : []
  }

  if (node.type === '市场') {
    const storeRows = await db
      .select({ storeId: stores.storeId })
      .from(stores)
      .innerJoin(orgNodes, eq(stores.orgNodeId, orgNodes.id))
      .where(eq(orgNodes.parentId, orgNodeId))
    return storeRows.map((r) => r.storeId)
  }

  return null
}


export const getCustomersForBatchIssue = withPermission(
  'coupon:create',
  async (
    _session,
    filters: {
      orgNodeId?: string
      memberLevel?: string
      search?: string
      page?: number
      pageSize?: number
    },
  ): Promise<{ data: BatchCouponCustomer[]; total: number }> => {
    const page = Math.max(1, filters.page || 1)
    const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
    const offset = (page - 1) * pageSize

    const conditions: (SQL | undefined)[] = [
      isNotNull(clientWechatUsers.phone),
    ]

    
    if (filters.orgNodeId) {
      const storeIds = await resolveOrgNodeToStoreIds(filters.orgNodeId)
      if (storeIds !== null) {
        if (storeIds.length === 0) {
          return { data: [], total: 0 }
        } else if (storeIds.length === 1) {
          conditions.push(eq(clientWechatUsers.boundStoreId, storeIds[0]))
        } else {
          conditions.push(inArray(clientWechatUsers.boundStoreId, storeIds))
        }
      }
    }

    if (filters.memberLevel) {
      conditions.push(eq(clientWechatUsers.memberLevel, filters.memberLevel as typeof clientWechatUsers.memberLevel.enumValues[number]))
    }
    if (filters.search) {
      const pattern = `%${filters.search}%`
      conditions.push(
        or(
          ilike(clientWechatUsers.name, pattern),
          ilike(clientWechatUsers.phone, pattern),
        ),
      )
    }

    const whereClause = and(...conditions)

    const [[countRow], rows] = await Promise.all([
      db.select({ count: sql<number>`cast(count(*) as int)` })
        .from(clientWechatUsers)
        .where(whereClause),
      db.select({
        userId: clientWechatUsers.userId,
        name: clientWechatUsers.name,
        phone: clientWechatUsers.phone,
        storeName: stores.storeName,
        memberLevel: clientWechatUsers.memberLevel,
      })
        .from(clientWechatUsers)
        .leftJoin(stores, eq(clientWechatUsers.boundStoreId, stores.storeId))
        .where(whereClause)
        
        .orderBy(asc(clientWechatUsers.name))
        .limit(pageSize)
        .offset(offset),
    ])

    return {
      data: rows.map((r) => ({
        userId: r.userId,
        name: r.name,
        phone: r.phone,
        storeName: r.storeName ?? null,
        memberLevel: r.memberLevel,
      })),
      total: countRow?.count ?? 0,
    }
  },
)


export const getOrgNodesForBatchIssue = withPermission(
  'coupon:create',
  async (_session): Promise<OrgNode[]> => {
    const rows = await db
      .select()
      .from(orgNodes)
      
      .orderBy(asc(orgNodes.sortOrder))
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      parentId: row.parentId,
      sortOrder: row.sortOrder,
      isActive: row.isActive,
      createdAt: row.createdAt?.toISOString() ?? '',
      updatedAt: row.updatedAt?.toISOString() ?? '',
    }))
  },
)
