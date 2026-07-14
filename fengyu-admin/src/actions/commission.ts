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

export interface MarketOption {
  orgId: string
  name: string
}

export const getMarkets = withPermission(
  'commission:list',
  async (session): Promise<MarketOption[]> => {
  const visibleIds = await expandVisibleMarketIds(session)
  
  if (visibleIds !== null && visibleIds.length === 0) return []

  const scopeCond = visibleIds === null ? undefined : inArray(orgNodes.id, visibleIds)
  const rows = await db
    .select({ id: orgNodes.id, name: orgNodes.name })
    .from(orgNodes)
    .where(and(eq(orgNodes.type, '市场'), scopeCond))
    
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
      createdAt: commissionRateMatrix.createdAt,
      updatedAt: commissionRateMatrix.updatedAt,
      orgName: orgNodes.name,
    })
    .from(commissionRateMatrix)
    .leftJoin(orgNodes, eq(commissionRateMatrix.orgId, orgNodes.id))
    
    .orderBy(desc(commissionRateMatrix.updatedAt), desc(commissionRateMatrix.id))
    .limit(1000)

  return rows.map((r) => ({
    id: r.id,
    orgId: r.orgId,
    orderType: r.orderType,
    roleType: r.roleType,
    salesCategory: r.salesCategory,
    amountTierMin: r.amountTierMin,
    amountTierMax: r.amountTierMax,
    commissionRate: r.commissionRate,
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
    },
  ): Promise<{ success: boolean; message: string }> => {
  
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
    },
    
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
  
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

  
  const [before] = await db.select().from(commissionRateMatrix).where(eq(commissionRateMatrix.id, id)).limit(1)

  const whereConditions = expectedUpdatedAt
    ? and(eq(commissionRateMatrix.id, id), sql`date_trunc('milliseconds', ${commissionRateMatrix.updatedAt}) = ${expectedUpdatedAt}`)
    : eq(commissionRateMatrix.id, id)

  let result: any
  try {
    result = await db
      .update(commissionRateMatrix)
      .set(data)
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

  await logUpdate(session, 'commission.update', 'commission_rate', String(id), before as Record<string, unknown>, data)
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
    
    or(
      isNull(commissionRateMatrix.amountTierMax),
      gt(commissionRateMatrix.amountTierMax, data.amountTierMin),
    ) as ReturnType<typeof eq>,
  ]

  
  if (data.amountTierMax) {
    conditions.push(
      lt(commissionRateMatrix.amountTierMin, data.amountTierMax) as ReturnType<typeof eq>,
    )
  }

  
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
