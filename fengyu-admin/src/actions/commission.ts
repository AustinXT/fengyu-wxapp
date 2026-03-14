'use server'

import { db } from '@/db'
import { commissionRateMatrix } from '@db/commission'
import { orgNodes } from '@db/org'
import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { CommissionRate } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'

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
}) {
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
  }
) {
  const session = await getSession()
  requirePermission(session, 'commission:update')

  await db
    .update(commissionRateMatrix)
    .set(data)
    .where(eq(commissionRateMatrix.id, id))

  await logOperation(session, 'commission.update', 'commission_rate', String(id), data)
  revalidatePath('/commission')
}

export async function deleteRate(id: number) {
  const session = await getSession()
  requirePermission(session, 'commission:delete')

  await db
    .delete(commissionRateMatrix)
    .where(eq(commissionRateMatrix.id, id))

  await logOperation(session, 'commission.delete', 'commission_rate', String(id))
  revalidatePath('/commission')
}
