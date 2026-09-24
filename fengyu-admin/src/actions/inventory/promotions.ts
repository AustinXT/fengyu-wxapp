'use server'

import { db } from '@/db'
import { ApiError } from '@/lib/api-error'
import {
  createInventoryPromotionPlan as createInventoryPromotionPlanImpl,
  disableInventoryPromotionPlan as disableInventoryPromotionPlanImpl,
  getInventoryPromotionPlanById as getInventoryPromotionPlanByIdImpl,
  listInventoryPromotionPlans as listInventoryPromotionPlansImpl,
  updateInventoryPromotionPlan as updateInventoryPromotionPlanImpl,
} from '@/lib/inventory/engine'
import { isAdminScope } from '@/lib/permissions'
import type { AuthSession } from '@/lib/types'
import type { InventoryPromotionPlanInput } from '@/lib/inventory/types'
import { withAnyPermission, withPermission } from '@/lib/with-permission'
import { inventoryPromotionPlans } from '@db/inventory'
import { eq } from 'drizzle-orm'

async function assertGlobalPromotionMutable(session: AuthSession, id: string): Promise<void> {
  const [plan] = await db
    .select({ scopeMarketId: inventoryPromotionPlans.scopeMarketId })
    .from(inventoryPromotionPlans)
    .where(eq(inventoryPromotionPlans.id, id))
    .limit(1)

  // 不存在或对当前市场不可见的方案仍交给引擎层统一返回 NOT_FOUND。
  if (!plan || plan.scopeMarketId !== null) return
  if (isAdminScope(session) || session.roles.some((role) => role.scopeType === '总部')) return
  throw new ApiError('PERMISSION_DENIED', '市场用户不能修改或停用全局福利方案')
}

export const listInventoryPromotionPlans = withPermission(
  'inventory:stock_list',
  async () => listInventoryPromotionPlansImpl(),
)

export const getInventoryPromotionPlanById = withPermission(
  'inventory:stock_list',
  async (_session, id: string) => getInventoryPromotionPlanByIdImpl(id),
)

export const createInventoryPromotionPlan = withAnyPermission(
  ['inventory:supply_chain_master_data_manage', 'inventory:market_operate'],
  async (_session, input: InventoryPromotionPlanInput) => createInventoryPromotionPlanImpl(input),
)

export const updateInventoryPromotionPlan = withAnyPermission(
  ['inventory:supply_chain_master_data_manage', 'inventory:market_operate'],
  async (session, id: string, input: InventoryPromotionPlanInput) => {
    await assertGlobalPromotionMutable(session, id)
    return updateInventoryPromotionPlanImpl(id, input)
  },
)

export const disableInventoryPromotionPlan = withAnyPermission(
  ['inventory:supply_chain_master_data_manage', 'inventory:market_operate'],
  async (session, id: string) => {
    await assertGlobalPromotionMutable(session, id)
    return disableInventoryPromotionPlanImpl(id)
  },
)
