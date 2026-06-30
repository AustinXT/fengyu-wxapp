'use server'

import { db } from '@/db'
import { pgErrorCode } from '@/lib/pg-error'
import { couponTemplates, userCoupons } from '@db/coupon'
import { clientWechatUsers } from '@db/user'
import { orgNodes, stores } from '@db/org'
import { productCategories } from '@db/product'
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

/**
 * coupon_templates.valid_from / valid_to 写入：入参是 date input 日期串（'YYYY-MM-DD'）。
 * 按北京字面拼 timestamp（开始=当天 00:00:00、结束=当天 23:59:59），与前端 coupon-validity-helper
 * 及 validateValidityFields 同口径。**不经 new Date/beijingTs**：date-only 串按 ES 规范当 UTC 午夜解析、
 * 再 beijingTs 会偏 +8h（同 orders.ts 报表筛选 bug，见 lib/db-time）。DB 现值（Date）走 fmtDate 取北京日期。
 */
function validBoundTs(value: string | Date, time: '00:00:00' | '23:59:59') {
  return sql`${`${fmtDate(value)} ${time}`}::timestamp`
}

/**
 * 有效期字段校验（基于合并后的完整状态）。
 * createTemplate 直接传入提交数据；updateTemplate 传入 DB 现值 merge 补丁的 merged。
 * 错误消息必须与前端 `validateCouponValidityFields` helper 字符级一致。
 */
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
    // 规整为北京日期 YYYY-MM-DD：string（type=date 提交值，new Date 当 UTC 午夜会偏）取前 10 位；
    // Date（DB 现值，admin 进程 TZ=Asia/Shanghai）按北京时区取日期。结束日期以当天 23:59:59 为界，
    // 避免北京凌晨把"今天到期"误判为已过期（与前端 coupon-validity-helper 字符级一致）。
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

/**
 * 获取所有市场节点（type='市场'），用于优惠券市场作用域选择。
 * 按当前账号 scope 过滤：总部全开；市场/门店级仅返回所在市场。
 */
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
      // 例外：sortOrder 手工排序权重
      .orderBy(asc(orgNodes.sortOrder))

    return rows
  },
)

/**
 * 获取品项分类列表（品项券适用范围选择用）。
 * 权限走 coupon:list，避免依赖 product:list。
 */
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
      // 例外：sortOrder 手工排序权重
      .orderBy(asc(productCategories.sortOrder))

    return rows.map((r) => ({
      categoryId: r.categoryId,
      categoryName: r.categoryName,
      productKind: r.productKind,
    }))
  },
)

/**
 * 查询顾客在当前订单金额下可用的优惠券列表。
 * 过滤规则：未使用 + 未过期 + 模板启用 + 满足 minSpend + storeId 适用（if set）+ 市场适用
 */
export const getAvailableCoupons = withPermission(
  'sale_order:create',
  async (
    _session,
    clientUserId: string,
    totalAmount: number,
    storeId?: string,
  ): Promise<AvailableCoupon[]> => {
    // 防御性强制数值化：避免外部调用方透传字符串导致 PG 隐式 cast 边界抖动
    // 并归一化到分，与 client/staff coupon.available / order.create 对齐
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

    // 市场过滤：先解析 storeId → marketId，再检查 applicableMarketIds
    let marketCondition
    if (storeId) {
      // 通过 stores → org_nodes 找到门店所属市场
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
        lte(sql`COALESCE(${couponTemplates.minSpend}, '0')::numeric`, total),
        storeCondition,
        marketCondition,
      ))
      // 例外：业务时间优先（即将过期的券靠前显示）
      .orderBy(asc(userCoupons.expireAt))

    return rows.map((r) => {
      const discount = calcCouponDiscount(r.couponType, r.discountValue, r.maxDiscount ?? null, total)
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
      // 默认排序：最近编辑过的模板浮顶（admin.sys.spec.md §5）
      .orderBy(desc(couponTemplates.updatedAt), desc(couponTemplates.createdAt))
      .limit(500)

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
    // 校验券种类型
    const VALID_COUPON_TYPES = ['现金券', '品项券', '折扣券']
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

    // 校验有效期字段（days/fixed 分支）
    const validityCheck = validateValidityFields({
      validityMode: data.validityMode,
      validDays: data.validDays ?? null,
      validFrom: data.validFrom ?? null,
      validTo: data.validTo ?? null,
    })
    if (!validityCheck.ok) {
      return { success: false, message: validityCheck.message }
    }

    // 根据模式强制另一侧为 null，避免脏数据
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
    /** 乐观锁：提交时携带的 updated_at */
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
    // 获取旧值用于日志 diff + 合并校验
    const [before] = await db.select().from(couponTemplates).where(eq(couponTemplates.templateId, templateId)).limit(1)

    if (!before) {
      return { success: false, message: '优惠券模板不存在' }
    }

    // 若 patch 触及任一有效期相关字段，必须走合并后的完整校验
    const patchTouchesValidity =
      data.validityMode !== undefined ||
      data.validDays !== undefined ||
      data.validFrom !== undefined ||
      data.validTo !== undefined

    const updateData: Record<string, unknown> = { ...data }

    if (patchTouchesValidity) {
      // 检测模式切换：patch 显式把 validityMode 从 before 的模式切到另一个模式
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

      // 构造 merged = before ∪ patch（patch 中显式出现的字段覆盖 before）
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

      // 根据 merged 模式强制清空另一侧字段
      if (merged.validityMode === 'days') {
        updateData.validFrom = null
        updateData.validTo = null
        updateData.validDays = merged.validDays
      } else {
        updateData.validDays = null
        // fixed 模式写 valid_from/valid_to：取 patch 串或 DB 现值，按北京字面拼 00:00:00/23:59:59
        // （merged.validFrom 是 Date 仅供校验；写库须用 validBoundTs 避免 new Date/beijingTs 的 +8h）。
        const fromSrc = data.validFrom !== undefined ? data.validFrom : (before as any).validFrom
        const toSrc = data.validTo !== undefined ? data.validTo : (before as any).validTo
        updateData.validFrom = fromSrc ? validBoundTs(fromSrc, '00:00:00') : null
        updateData.validTo = toSrc ? validBoundTs(toSrc, '23:59:59') : null
      }
    } else {
      // 未触及有效期字段，仍需规范日期序列化（保持旧行为）
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
    /** 乐观锁：提交时携带的 updated_at */
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

/**
 * 向指定顾客发放一张优惠券。
 * 校验：模板启用 + 发放量未超限 + 顾客存在 + 有效期计算。
 */
export const issueCoupon = withPermission(
  'coupon:create',
  async (
    session,
    templateId: string,
    phone: string,
  ): Promise<{ success: boolean; message: string }> => {
    // 1. 查模板
    const [tpl] = await db
      .select()
      .from(couponTemplates)
      .where(eq(couponTemplates.templateId, templateId))
      .limit(1)

    if (!tpl) return { success: false, message: '优惠券模板不存在' }
    if (!tpl.isActive) return { success: false, message: '该模板已停用，无法发放' }

    // 2. 校验发放量限制
    if (tpl.totalCount !== null) {
      const [{ count }] = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(userCoupons)
        .where(eq(userCoupons.templateId, templateId))

      if (count >= tpl.totalCount) {
        return { success: false, message: `发放数量已达上限（${tpl.totalCount}）` }
      }
    }

    // 3. 查顾客
    const [customer] = await db
      .select({ userId: clientWechatUsers.userId, name: clientWechatUsers.name })
      .from(clientWechatUsers)
      .where(eq(clientWechatUsers.phone, phone))
      .limit(1)

    if (!customer) return { success: false, message: '未找到该手机号对应的顾客' }

    // 4. 计算 expireAt（写北京墙钟字面，见 lib/db-time；原 new Date() 经 postgres.js 落 UTC 字面早 8h）
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

    // 5. 生成 couponId 并插入
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

/**
 * 查询某模板下的所有已发放券记录。
 */
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
      // 例外：已发放流水，user_coupons 表无 updatedAt 列
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

/**
 * 批量向多个顾客发放优惠券。
 * 全有全无：所有手机号必须匹配顾客，否则整批拒绝。
 */
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
    // 1. 去重 + 基本校验
    const uniquePhones = [...new Set(phones.map((p) => p.trim()).filter(Boolean))]
    if (uniquePhones.length === 0) {
      return { success: false, message: '请输入至少一个手机号' }
    }
    if (uniquePhones.length > 200) {
      return { success: false, message: '单次批量发放不能超过 200 个手机号' }
    }

    // 2. 查模板
    const [tpl] = await db
      .select()
      .from(couponTemplates)
      .where(eq(couponTemplates.templateId, templateId))
      .limit(1)

    if (!tpl) return { success: false, message: '优惠券模板不存在' }
    if (!tpl.isActive) return { success: false, message: '该模板已停用，无法发放' }

    // 3. 校验发放量限制
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

    // 4. 批量查顾客
    const customers = await db
      .select({ userId: clientWechatUsers.userId, name: clientWechatUsers.name, phone: clientWechatUsers.phone })
      .from(clientWechatUsers)
      .where(inArray(clientWechatUsers.phone, uniquePhones))

    const customerMap = new Map(customers.map((c) => [c.phone!, { userId: c.userId, name: c.name }]))

    // 5. 检查未匹配手机号
    const errors: Array<{ phone: string; reason: string }> = []
    for (const phone of uniquePhones) {
      if (!customerMap.has(phone)) {
        errors.push({ phone, reason: '未找到该手机号对应的顾客' })
      }
    }
    if (errors.length > 0) {
      return { success: false, message: `有 ${errors.length} 个手机号未匹配到顾客`, errors }
    }

    // 6. 计算 expireAt（写北京墙钟字面，见 lib/db-time）
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

    // 7. 事务内批量插入
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

    // 8. 审计日志
    await logOperation(session, 'coupon.batchIssue', 'coupon_template', templateId, {
      templateName: tpl.name,
      count: uniquePhones.length,
      phones: uniquePhones,
    })

    revalidatePath(`/coupons/${templateId}`)
    return { success: true, message: `已成功向 ${uniquePhones.length} 位顾客批量发放优惠券` }
  },
)

/**
 * 将组织节点 ID 解析为对应的 storeId 列表。
 * 返回 null 表示不过滤（总部 / 未知），空数组表示无匹配门店。
 */
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

/**
 * 批量发券时的顾客分页列表。
 * 权限走 coupon:create（而非 customer:list），以便 product 角色可用。
 * 仅返回有手机号的顾客。
 */
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

    // 组织节点 → storeIds 过滤
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
        // 例外：picker 字母序
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

/**
 * 组织树节点列表（批量发券筛选用）。
 * 权限走 coupon:create，product 角色无 org:list 但有此权限。
 */
export const getOrgNodesForBatchIssue = withPermission(
  'coupon:create',
  async (_session): Promise<OrgNode[]> => {
    const rows = await db
      .select()
      .from(orgNodes)
      // 例外：sortOrder 手工排序权重
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
