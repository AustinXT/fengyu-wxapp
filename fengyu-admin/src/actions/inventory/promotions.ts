'use server'

import {
  createInventoryPromotionPlan as createInventoryPromotionPlanImpl,
  disableInventoryPromotionPlan as disableInventoryPromotionPlanImpl,
  getInventoryPromotionPlanById as getInventoryPromotionPlanByIdImpl,
  listInventoryPromotionPlans as listInventoryPromotionPlansImpl,
  updateInventoryPromotionPlan as updateInventoryPromotionPlanImpl,
} from '@/lib/inventory/engine'
import {
  INVENTORY_PROMOTION_MAINTAIN_ACTION,
  assertInventoryPromotionMaintainer,
} from '@/lib/inventory/access'
import type { InventoryPromotionPlanInput } from '@/lib/inventory/types'
import { withPermission } from '@/lib/with-permission'

export const listInventoryPromotionPlans = withPermission(
  'inventory:stock_list',
  async () => listInventoryPromotionPlansImpl(),
)

export const getInventoryPromotionPlanById = withPermission(
  'inventory:stock_list',
  async (_session, id: string) => getInventoryPromotionPlanByIdImpl(id),
)

// 报货福利方案只由总部供应链维护（#354）：市场侧只读，引擎层同名导出另有同一道校验。
export const createInventoryPromotionPlan = withPermission(
  INVENTORY_PROMOTION_MAINTAIN_ACTION,
  async (session, input: InventoryPromotionPlanInput) => {
    assertInventoryPromotionMaintainer(session)
    return createInventoryPromotionPlanImpl(input)
  },
)

export const updateInventoryPromotionPlan = withPermission(
  INVENTORY_PROMOTION_MAINTAIN_ACTION,
  async (session, id: string, input: InventoryPromotionPlanInput) => {
    assertInventoryPromotionMaintainer(session)
    return updateInventoryPromotionPlanImpl(id, input)
  },
)

export const disableInventoryPromotionPlan = withPermission(
  INVENTORY_PROMOTION_MAINTAIN_ACTION,
  async (session, id: string) => {
    assertInventoryPromotionMaintainer(session)
    return disableInventoryPromotionPlanImpl(id)
  },
)
