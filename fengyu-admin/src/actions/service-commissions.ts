'use server'

import { db } from '@/db'
import { pgErrorCode } from '@/lib/pg-error'
import { serviceCommissions } from '@db/service-commission'
import { serviceOrders, serviceItems } from '@db/service'
import { saleItems } from '@db/order'
import { commissionRateMatrix } from '@db/commission'
import { eq, sql, and, inArray, desc } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { ServiceCommission, AuthSession } from '@/lib/types'
import { isAdminScope } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { logOperation } from '@/lib/operation-log'
import { ApiError } from '@/lib/api-error'
import { hasPendingRefundByServiceOrder } from '@/lib/refund-cascade'
import { DEPOSIT_REFUND_REMARK } from '@/lib/service-remark'


async function verifyServiceOrderScope(serviceOrderId: string, session: AuthSession): Promise<boolean> {
  if (isAdminScope(session)) return true
  const scopeIds = session.permissions.scopeStoreIds
  if (scopeIds.length === 0) return false
  const [order] = await db
    .select({ storeId: serviceOrders.storeId })
    .from(serviceOrders)
    .where(eq(serviceOrders.serviceOrderId, serviceOrderId))
    .limit(1)
  return !!order && scopeIds.includes(order.storeId)
}

export const getServiceOrderCommissions = withPermission(
  'allocation:list',
  async (session, serviceOrderId: string): Promise<ServiceCommission[]> => {
  if (!(await verifyServiceOrderScope(serviceOrderId, session))) {
    return []
  }

  const rows = await db.execute(sql`
    SELECT
      sc.id, sc.service_item_id, sc.employee_id, sc.role_type, sc.allocation_ratio,
      sc.commission_rate, sc.commission_amount, sc.is_void, sc.created_at, sc.updated_at,
      swu.name AS employee_name, orn.name AS department_name
    FROM service_commissions sc
    LEFT JOIN staff_wechat_users swu ON sc.employee_id = swu.employee_id
    LEFT JOIN org_nodes orn ON swu.org_node_id = orn.id
    WHERE sc.service_item_id IN (
      SELECT si.service_item_id FROM service_items si WHERE si.service_order_id = ${serviceOrderId}
    ) AND sc.is_void = false
  `) as any[]

  return (rows as any[]).map((r: any) => ({
    id: Number(r.id),
    serviceItemId: r.service_item_id,
    employeeId: r.employee_id,
    roleType: r.role_type ?? undefined,
    allocationRatio: r.allocation_ratio ?? undefined,
    commissionRate: r.commission_rate,
    commissionAmount: r.commission_amount,
    isVoid: r.is_void,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    employeeName: r.employee_name ?? undefined,
    departmentName: r.department_name ?? undefined,
  }))
  },
)


function getPoolKey(roleType: string): string {
  return roleType
}


const VALID_RATIOS = new Set(['0.10', '0.20', '0.30', '0.40', '0.50', '0.60', '0.70', '0.80', '0.90', '1.00'])


export const batchSaveServiceCommissions = withPermission(
  'allocation:save',
  async (
    session,
    serviceOrderId: string,
    commissions: Array<{
      serviceItemId: string
      employeeId: string
      roleType: string
      allocationRatio: string
      commissionRate: string
      commissionAmount: string
    }>,
  ): Promise<{ success: boolean; message: string }> => {
  if (!(await verifyServiceOrderScope(serviceOrderId, session))) {
    return { success: false, message: '无权操作该服务单的提成分配' }
  }

  
  
  if (await hasPendingRefundByServiceOrder(db, serviceOrderId)) {
    return { success: false, message: '关联订单退款审批中，暂不可调整提成分配' }
  }

  
  
  const [svcRemark] = await db
    .select({ remark: serviceOrders.remark })
    .from(serviceOrders)
    .where(eq(serviceOrders.serviceOrderId, serviceOrderId))
    .limit(1)
  if (svcRemark?.remark === DEPOSIT_REFUND_REMARK) {
    return { success: false, message: '寄存单退款专用服务单不参与提成分配' }
  }

  
  if (commissions.length > 0) {
    const serviceItemIds = [...new Set(commissions.map((c) => c.serviceItemId))]
    const validItems = await db
      .select({ serviceItemId: serviceItems.serviceItemId })
      .from(serviceItems)
      .where(and(
        inArray(serviceItems.serviceItemId, serviceItemIds),
        eq(serviceItems.serviceOrderId, serviceOrderId),
      ))
    const validSet = new Set(validItems.map((i) => i.serviceItemId))
    const invalid = serviceItemIds.find((id) => !validSet.has(id))
    if (invalid) {
      return { success: false, message: '服务明细不属于该服务单，请刷新后重试' }
    }

    
    for (const c of commissions) {
      if (!VALID_RATIOS.has(c.allocationRatio)) {
        return { success: false, message: '分配比例必须为整十百分比（10%~100%）' }
      }
    }

    
    const pools = new Map<string, typeof commissions>()
    for (const c of commissions) {
      const key = `${c.serviceItemId}|${getPoolKey(c.roleType)}`
      const pool = pools.get(key) || []
      pool.push(c)
      pools.set(key, pool)
    }

    for (const [, pool] of pools) {
      if (pool.length > 3) {
        return { success: false, message: '每个服务明细每个技能标签最多分配 3 人' }
      }

      const ratioSum = pool.reduce((s, c) => s + Number(c.allocationRatio), 0)
      if (ratioSum > 1.01) {
        return { success: false, message: '同技能标签的分配比例合计不能超过 100%' }
      }

      const empIds = new Set<string>()
      for (const c of pool) {
        if (empIds.has(c.employeeId)) {
          return { success: false, message: '同一服务明细同一技能标签不能重复分配同一员工' }
        }
        empIds.add(c.employeeId)
      }
    }
  }

  
  
  const pricingByItemId = new Map<string, {
    unitRealPrice: string
    sessionUsed: number
    salesCategory: string | null
    serviceFee: string
  }>()

  if (commissions.length > 0) {
    const serviceItemIds = [...new Set(commissions.map((c) => c.serviceItemId))]
    const pricingRows = await db
      .select({
        serviceItemId: serviceItems.serviceItemId,
        unitRealPrice: serviceItems.unitRealPrice,
        sessionUsed: serviceItems.sessionUsed,
        salesCategory: serviceItems.salesCategory,
        serviceFee: saleItems.serviceFee,
      })
      .from(serviceItems)
      .innerJoin(saleItems, eq(serviceItems.saleItemId, saleItems.saleItemId))
      .where(inArray(serviceItems.serviceItemId, serviceItemIds))

    for (const row of pricingRows) {
      pricingByItemId.set(row.serviceItemId, {
        unitRealPrice: row.unitRealPrice ?? '0',
        sessionUsed: row.sessionUsed,
        salesCategory: row.salesCategory,
        serviceFee: row.serviceFee ?? '0',
      })
    }
  }

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE service_commissions SET is_void = true
        WHERE service_item_id IN (
          SELECT service_item_id FROM service_items WHERE service_order_id = ${serviceOrderId}
        ) AND is_void = false
      `)

      if (commissions.length > 0) {
        
        const values = []
        for (const c of commissions) {
          const pricing = pricingByItemId.get(c.serviceItemId)
          if (!pricing) {
            throw new Error(`INVALID_PARAMS: 服务明细 ${c.serviceItemId} 不存在或缺少价格数据`)
          }

          const ratio = Number(c.allocationRatio)
          
          const fixedFee = Math.round(Number(pricing.serviceFee) * pricing.sessionUsed * ratio * 100) / 100
          
          const perSession = Number(pricing.unitRealPrice)
          
          const consumeBase = Math.round(perSession * pricing.sessionUsed * 100) / 100

          
          const salesCategory = pricing.salesCategory
          const rateRows = await tx
            .select({ commissionRate: commissionRateMatrix.commissionRate })
            .from(commissionRateMatrix)
            .where(and(
              eq(commissionRateMatrix.orderType, '服务单'),
              eq(commissionRateMatrix.roleType, c.roleType),
              sql`${commissionRateMatrix.salesCategory} = ${salesCategory}`,
              sql`${commissionRateMatrix.amountTierMin} <= ${consumeBase}`,
              sql`(${commissionRateMatrix.amountTierMax} IS NULL OR ${commissionRateMatrix.amountTierMax} >= ${consumeBase})`,
              
              sql`${commissionRateMatrix.orgId} = (
                SELECT m.id FROM service_orders so
                  JOIN stores s ON so.store_id = s.store_id
                  JOIN org_nodes son ON s.org_node_id = son.id
                  JOIN org_nodes m ON son.parent_id = m.id
                 WHERE so.service_order_id = ${serviceOrderId}
              )`,
            ))
            .orderBy(desc(commissionRateMatrix.amountTierMin))
            .limit(1)

          const rate = Number(rateRows[0]?.commissionRate || 0)
          if (rate === 0 && consumeBase > 0) {
            throw new ApiError(
              'INVALID_STATE',
              `COMMISSION_RATE_MISSING: serviceItemId=${c.serviceItemId}, roleType=${c.roleType}, salesCategory=${salesCategory}, consumeBase=${consumeBase}`
            )
          }

          const consumeAmount = Math.round(consumeBase * ratio * rate * 100) / 100
          const commissionAmount = Math.round((fixedFee + consumeAmount) * 100) / 100

          values.push({
            serviceItemId: c.serviceItemId,
            employeeId: c.employeeId,
            roleType: c.roleType,
            allocationRatio: c.allocationRatio,
            commissionRate: String(rate),
            fixedFee: String(fixedFee),
            consumeAmount: String(consumeAmount),
            commissionAmount: String(commissionAmount),
          })
        }

        await tx.insert(serviceCommissions).values(values)
      }

      await tx
        .update(serviceOrders)
        .set({ commissionStatus: commissions.length > 0 ? '已分配' : '待分配' })
        .where(eq(serviceOrders.serviceOrderId, serviceOrderId))
    })
  } catch (err: any) {
    if (pgErrorCode(err) === '23503') {
      return { success: false, message: '员工信息不存在，请检查后重试' }
    }
    throw err
  }

  await logOperation(session, 'serviceCommission.batchSave', 'service_order', serviceOrderId, {
    commissionCount: commissions.length,
  })

  revalidatePath('/allocations')
  return { success: true, message: '服务提成保存成功' }
  },
)
