'use server'

import { db } from '@/db'
import { commissionRateMatrix } from '@db/commission'
import { orgNodes } from '@db/org'
import { eq, and } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { CommissionRate } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'

export interface MarketOption {
  orgId: string
  name: string
}

export async function getMarkets(): Promise<MarketOption[]> {
  const session = await getSession()
  requirePermission(session, 'commission:list')

  const rows = await db
    .select({ id: orgNodes.id, name: orgNodes.name })
    .from(orgNodes)
    .where(eq(orgNodes.type, 'market'))
    .orderBy(orgNodes.sortOrder)

  return rows.map((r) => ({ orgId: r.id, name: r.name }))
}

export async function getRates(): Promise<CommissionRate[]> {
  const session = await getSession()
  requirePermission(session, 'commission:list')

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
    .orderBy(commissionRateMatrix.id)

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
}

export async function createRate(data: {
  orgId: string
  orderType: string
  roleType: string
  salesCategory: string
  amountTierMin: string
  amountTierMax?: string | null
  commissionRate: string
}): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'commission:create')

  await db.insert(commissionRateMatrix).values({
    orgId: data.orgId,
    orderType: data.orderType,
    roleType: data.roleType,
    salesCategory: data.salesCategory,
    amountTierMin: data.amountTierMin,
    amountTierMax: data.amountTierMax ?? null,
    commissionRate: data.commissionRate,
  })

  await logOperation(session, 'commission.create', 'commission_rate', data.orgId, {
    orderType: data.orderType, roleType: data.roleType,
  })
  revalidatePath('/commission')
  return { success: true, message: '提成规则创建成功' }
}

export async function updateRate(
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
  /** 乐观锁：提交时携带的 updated_at */
  expectedUpdatedAt?: string,
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'commission:update')

  const whereConditions = expectedUpdatedAt
    ? and(eq(commissionRateMatrix.id, id), eq(commissionRateMatrix.updatedAt, new Date(expectedUpdatedAt)))
    : eq(commissionRateMatrix.id, id)

  const result = await db
    .update(commissionRateMatrix)
    .set(data)
    .where(whereConditions)

  if (expectedUpdatedAt && (result as any).rowCount === 0) {
    return { success: false, message: '数据已被其他人修改，请刷新后重试' }
  }

  await logOperation(session, 'commission.update', 'commission_rate', String(id), data)
  revalidatePath('/commission')
  return { success: true, message: '提成规则已更新' }
}

export async function deleteRate(id: number): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'commission:delete')

  await db
    .delete(commissionRateMatrix)
    .where(eq(commissionRateMatrix.id, id))

  await logOperation(session, 'commission.delete', 'commission_rate', String(id))
  revalidatePath('/commission')
  return { success: true, message: '提成规则已删除' }
}
