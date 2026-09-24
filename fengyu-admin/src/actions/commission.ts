'use server'

import { db } from '@/db'
import { pgErrorCode } from '@/lib/pg-error'
import { commissionRateMatrix } from '@db/commission'
import { orgNodes } from '@db/org'
import { eq, and, or, isNull, gt, lt, ne, sql, desc, asc, inArray } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { CommissionRate } from '@/lib/types'
import { withPermission } from '@/lib/with-permission'
import { expandVisibleMarketIds, requireAdmin } from '@/lib/permissions'
import { logOperation, logUpdate } from '@/lib/operation-log'
import { DEFAULT_PRICE_THRESHOLD, isPriceThresholdEligible, parsePriceThreshold } from '@/lib/commission-threshold'

const THRESHOLD_INELIGIBLE_MESSAGE = '单价阈值仅适用于服务单的自销自耗 / 他销自耗规则'

export interface MarketOption {
  orgId: string
  name: string
}

export const getMarkets = withPermission(
  'commission:list',
  async (session): Promise<MarketOption[]> => {
  const visibleIds = await expandVisibleMarketIds(session)
  // 非总部且无可见市场 → 直接返回空
  if (visibleIds !== null && visibleIds.length === 0) return []

  const scopeCond = visibleIds === null ? undefined : inArray(orgNodes.id, visibleIds)
  const rows = await db
    .select({ id: orgNodes.id, name: orgNodes.name })
    .from(orgNodes)
    .where(and(eq(orgNodes.type, '市场'), scopeCond))
    // 例外：sortOrder 手工排序权重
    .orderBy(asc(orgNodes.sortOrder))

  return rows.map((r) => ({ orgId: r.id, name: r.name }))
  },
)

export const getRates = withPermission(
  'commission:list',
  async (): Promise<CommissionRate[]> => {
  const rows = await db
    .select({
      id: commissionRateMatrix.id,
      orgId: commissionRateMatrix.orgId,
      orderType: commissionRateMatrix.orderType,
      roleType: commissionRateMatrix.roleType,
      salesCategory: commissionRateMatrix.salesCategory,
      amountTierMin: commissionRateMatrix.amountTierMin,
      amountTierMax: commissionRateMatrix.amountTierMax,
      commissionRate: commissionRateMatrix.commissionRate,
      priceThreshold: commissionRateMatrix.priceThreshold,
      createdAt: commissionRateMatrix.createdAt,
      updatedAt: commissionRateMatrix.updatedAt,
      orgName: orgNodes.name,
    })
    .from(commissionRateMatrix)
    .leftJoin(orgNodes, eq(commissionRateMatrix.orgId, orgNodes.id))
    // 默认排序：最近编辑过的规则浮顶（admin.sys.spec.md §5）
    .orderBy(desc(commissionRateMatrix.updatedAt), desc(commissionRateMatrix.id))

  return rows.map((r) => ({
    id: r.id,
    orgId: r.orgId,
    orderType: r.orderType,
    roleType: r.roleType,
    salesCategory: r.salesCategory,
    amountTierMin: r.amountTierMin,
    amountTierMax: r.amountTierMax,
    commissionRate: r.commissionRate,
    priceThreshold: r.priceThreshold,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    orgName: r.orgName ?? undefined,
  }))
  },
)

export const createRate = withPermission(
  'commission:create',
  async (
    session,
    data: {
      orgId: string
      orderType: string
      roleType: string
      salesCategory: string
      amountTierMin: string
      amountTierMax?: string | null
      commissionRate: string
      /** #379 undefined = 可配行取默认 100；null / '' = 不启用 */
      priceThreshold?: string | null
    },
  ): Promise<{ success: boolean; message: string }> => {
  let priceThreshold: string | null = null
  if (isPriceThresholdEligible(data.orderType, data.salesCategory)) {
    const parsed = data.priceThreshold === undefined
      ? { ok: true as const, value: DEFAULT_PRICE_THRESHOLD }
      : parsePriceThreshold(data.priceThreshold)
    if (!parsed.ok) return { success: false, message: parsed.message }
    priceThreshold = parsed.value
  } else if (data.priceThreshold != null && data.priceThreshold.trim() !== '') {
    return { success: false, message: THRESHOLD_INELIGIBLE_MESSAGE }
  }

  // 金额阶段重叠校验（AC-07）
  if (await hasTierOverlap(data)) {
    return { success: false, message: '金额阶段与现有规则重叠，请调整区间范围' }
  }

  try {
    await db.insert(commissionRateMatrix).values({
      orgId: data.orgId,
      orderType: data.orderType,
      roleType: data.roleType,
      salesCategory: data.salesCategory,
      amountTierMin: data.amountTierMin,
      amountTierMax: data.amountTierMax ?? null,
      commissionRate: data.commissionRate,
      priceThreshold,
    })
  } catch (err: any) {
    if (pgErrorCode(err) === '23505') {
      return { success: false, message: '相同条件的提成规则已存在' }
    }
    throw err
  }

  await logOperation(session, 'commission.create', 'commission_rate', data.orgId, {
    orderType: data.orderType, roleType: data.roleType,
  })
  revalidatePath('/commission')
  return { success: true, message: '提成规则创建成功' }
  },
)

export const updateRate = withPermission(
  'commission:update',
  async (
    session,
    id: number,
    data: {
      orgId?: string
      orderType?: string
      roleType?: string
      salesCategory?: string
      amountTierMin?: string
      amountTierMax?: string | null
      commissionRate?: string
      /** #379 undefined = 不改（类目由不可配切到可配时取默认 100）；null / '' = 不启用 */
      priceThreshold?: string | null
    },
    /** 乐观锁：提交时携带的 updated_at */
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
  // 金额阶段重叠校验（只有同时提供分类键和区间时才检查）
  if (
    data.orgId && data.orderType && data.roleType &&
    data.salesCategory && data.amountTierMin !== undefined
  ) {
    if (await hasTierOverlap({
      orgId: data.orgId,
      orderType: data.orderType,
      roleType: data.roleType,
      salesCategory: data.salesCategory,
      amountTierMin: data.amountTierMin,
      amountTierMax: data.amountTierMax,
    }, id)) {
      return { success: false, message: '金额阶段与现有规则重叠，请调整区间范围' }
    }
  }

  // 获取旧值用于日志 diff
  const [before] = await db.select().from(commissionRateMatrix).where(eq(commissionRateMatrix.id, id)).limit(1)
  if (!before) return { success: false, message: '提成规则不存在' }

  // #379 阈值按「改后」的订单类型 + 销售分类判定可配性；不可配行一律清空（否则撞 CHECK）
  const nextOrderType = data.orderType ?? before.orderType
  const nextSalesCategory = data.salesCategory ?? before.salesCategory
  let priceThreshold: string | null | undefined
  if (isPriceThresholdEligible(nextOrderType, nextSalesCategory)) {
    if (data.priceThreshold !== undefined) {
      const parsed = parsePriceThreshold(data.priceThreshold)
      if (!parsed.ok) return { success: false, message: parsed.message }
      priceThreshold = parsed.value
    } else if (!isPriceThresholdEligible(before.orderType, before.salesCategory)) {
      priceThreshold = DEFAULT_PRICE_THRESHOLD
    }
  } else {
    if (data.priceThreshold != null && data.priceThreshold.trim() !== '') {
      return { success: false, message: THRESHOLD_INELIGIBLE_MESSAGE }
    }
    priceThreshold = null
  }

  // 显式白名单：只写表单字段，不把调用方对象裸 spread 进 .set()
  const setValues: Partial<typeof commissionRateMatrix.$inferInsert> = {}
  if (data.orgId !== undefined) setValues.orgId = data.orgId
  if (data.orderType !== undefined) setValues.orderType = data.orderType
  if (data.roleType !== undefined) setValues.roleType = data.roleType
  if (data.salesCategory !== undefined) setValues.salesCategory = data.salesCategory
  if (data.amountTierMin !== undefined) setValues.amountTierMin = data.amountTierMin
  if (data.amountTierMax !== undefined) setValues.amountTierMax = data.amountTierMax
  if (data.commissionRate !== undefined) setValues.commissionRate = data.commissionRate
  if (priceThreshold !== undefined) setValues.priceThreshold = priceThreshold

  const whereConditions = expectedUpdatedAt
    ? and(eq(commissionRateMatrix.id, id), sql`date_trunc('milliseconds', ${commissionRateMatrix.updatedAt}) = ${expectedUpdatedAt}`)
    : eq(commissionRateMatrix.id, id)

  let result: any
  try {
    result = await db
      .update(commissionRateMatrix)
      .set(setValues)
      .where(whereConditions)
  } catch (err: any) {
    throw err
  }

  if ((result as any).count === 0) {
    return {
      success: false,
      message: expectedUpdatedAt ? '数据已被其他人修改，请刷新后重试' : '提成规则不存在',
    }
  }

  await logUpdate(session, 'commission.update', 'commission_rate', String(id), before as Record<string, unknown>, setValues)
  revalidatePath('/commission')
  return { success: true, message: '提成规则已更新' }
  },
)

export const deleteRate = withPermission(
  'commission:delete',
  async (session, id: number): Promise<{ success: boolean; message: string }> => {
  requireAdmin(session)
  let deleteResult: any
  try {
    deleteResult = await db
      .delete(commissionRateMatrix)
      .where(eq(commissionRateMatrix.id, id))
  } catch (err: any) {
    throw err
  }

  if ((deleteResult as any).count === 0) {
    return { success: false, message: '提成规则不存在' }
  }

  await logOperation(session, 'commission.delete', 'commission_rate', String(id))
  revalidatePath('/commission')
  return { success: true, message: '提成规则已删除' }
  },
)

/**
 * 检测给定分类键下新区间 [newMin, newMax) 是否与已有记录重叠。
 * 两区间 [a,b) 和 [c,d) 重叠条件：a < d AND c < b（null 视为 +∞）
 *
 * @param excludeId  更新时排除自身（避免与自身比较误判）
 */
async function hasTierOverlap(
  data: {
    orgId: string
    orderType: string
    roleType: string
    salesCategory: string
    amountTierMin: string
    amountTierMax?: string | null
  },
  excludeId?: number,
): Promise<boolean> {
  const conditions: ReturnType<typeof eq>[] = [
    eq(commissionRateMatrix.orgId, data.orgId),
    eq(commissionRateMatrix.orderType, data.orderType),
    eq(commissionRateMatrix.roleType, data.roleType),
    eq(commissionRateMatrix.salesCategory, data.salesCategory),
    // 现有区间右端 > 新区间左端（existMax > newMin, NULL=∞ 视为满足）
    or(
      isNull(commissionRateMatrix.amountTierMax),
      gt(commissionRateMatrix.amountTierMax, data.amountTierMin),
    ) as ReturnType<typeof eq>,
  ]

  // 若新区间有上限：现有区间左端 < 新区间右端（existMin < newMax）
  if (data.amountTierMax) {
    conditions.push(
      lt(commissionRateMatrix.amountTierMin, data.amountTierMax) as ReturnType<typeof eq>,
    )
  }

  // 更新时排除自身
  if (excludeId !== undefined) {
    conditions.push(ne(commissionRateMatrix.id, excludeId) as ReturnType<typeof eq>)
  }

  const rows = await db
    .select({ id: commissionRateMatrix.id })
    .from(commissionRateMatrix)
    .where(and(...conditions))
    .limit(1)

  return rows.length > 0
}
