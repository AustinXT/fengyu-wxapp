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
import { hasPendingRefundByServiceOrder } from '@/lib/refund-cascade'
import { DEPOSIT_REFUND_REMARK } from '@/lib/service-remark'
import { getInvalidEmployeeAssignmentId } from '@/lib/employee-assignment-server'

/** 校验服务单是否在用户 scope 内 */
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

/** 技能标签池键：每个 roleType 独立建池（P2-14 Q5：池间互不约束） */
function getPoolKey(roleType: string): string {
  return roleType
}

/** 批量保存服务提成（先作废旧的，再插入新的） */
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

  // 冻结闭环（Bug I）：关联订单有待审批退款时禁止改提成（与 staff serviceCommission.save 对齐；
  // 退款 cascade 通道2 会作废服务提成，待审批期改提成会被随后 approve 静默作废）
  if (await hasPendingRefundByServiceOrder(db, serviceOrderId)) {
    return { success: false, message: '关联订单退款审批中，暂不可调整提成分配' }
  }

  // 寄存单退款专用服务单不参与提成分配（顾客退寄存卡次数，员工未实际提供服务）。
  // 正常寄存消费核销单照常参与服务提成（寄存单仍不计营业额分成，由 ALLOCATABLE_ORDER_TYPES 守卫）。
  const [svcRemark] = await db
    .select({ remark: serviceOrders.remark, storeId: serviceOrders.storeId })
    .from(serviceOrders)
    .where(eq(serviceOrders.serviceOrderId, serviceOrderId))
    .limit(1)
  if (svcRemark?.remark === DEPOSIT_REFUND_REMARK) {
    return { success: false, message: '寄存单退款专用服务单不参与提成分配' }
  }
  if (!svcRemark || await getInvalidEmployeeAssignmentId(
    commissions.map((commission) => commission.employeeId),
    svcRemark.storeId,
    { assignmentScope: 'allocationSupport' },
  )) {
    return { success: false, message: '所选员工不属于本门店且未开启出差支援' }
  }

  // 校验所有 serviceItemId 属于该服务单
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

    // 校验分配比例为 0~1（精度 0.001，支持自定义小数比例）
    for (const c of commissions) {
      const r = Number(Number(c.allocationRatio).toFixed(3))
      if (!(r > 0 && r <= 1)) {
        return { success: false, message: '分配比例必须为 0~1 之间（精度 0.001）' }
      }
    }

    // 按 (serviceItemId, roleType) 分池校验（P2-14 Q5：三角色独立池）
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

      // 容差 0.0001：仅吸收浮点漂移，不放过 ≥0.1% 真实超额（与 allocations/staffApi 同口径）
      const ratioSum = pool.reduce((s, c) => s + Number(c.allocationRatio), 0)
      if (ratioSum > 1.0001) {
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

  // ---------- Pre-fetch pricing data for server-side calculation ----------
  // per_session 已是 unit_real_price 直接取用，不再需要 quantity/session_count（per-session 重构后）
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
        UPDATE service_commissions SET is_void = true, voided_at = NOW()
        WHERE service_item_id IN (
          SELECT service_item_id FROM service_items WHERE service_order_id = ${serviceOrderId}
        ) AND is_void = false
      `)

      if (commissions.length > 0) {
        // Calculate each commission server-side
        const values = []
        for (const c of commissions) {
          const pricing = pricingByItemId.get(c.serviceItemId)
          if (!pricing) {
            throw new Error(`INVALID_PARAMS: 服务明细 ${c.serviceItemId} 不存在或缺少价格数据`)
          }

          const ratio = Number(c.allocationRatio)
          // fixed_fee 与 consume_amount 均按 allocationRatio 拆分（多人同池各取份额，对齐前端展示 + 销售提成侧）
          const fixedFee = Math.round(Number(pricing.serviceFee) * pricing.sessionUsed * ratio * 100) / 100
          // per-session 价格：service_items.unit_real_price 已是 per-session 单次价，直接取用（不再 ÷session_count）
          const perSession = Number(pricing.unitRealPrice)
          // consumeBase 为整池基数（不乘 ratio），仅用于 rate tier 命中；金额再按 ratio 拆分
          const consumeBase = Math.round(perSession * pricing.sessionUsed * 100) / 100

          // Look up commission rate from matrix
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
              // 按服务单所属市场过滤（service_order→store→org 树解析市场节点），避免跨市场费率行碰撞；与三端云函数镜像
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

          // 容错口径（对齐 finalize：lib/service-commission-settle.ts:114）：
          // 查无匹配行 / 命中行 rate=0 统一按 rate=0 落库，不阻塞保存（与 staffApi 镜像）。
          const rate = Number(rateRows[0]?.commissionRate || 0)

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
