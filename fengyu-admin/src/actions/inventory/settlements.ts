'use server'

import { listInventorySettlements as listInventorySettlementsImpl } from '@/lib/inventory/settlements'
import {
  exportSettlementSegmentDetailsForSession,
  listSettlementDetailsForSession,
} from '@/lib/inventory/settlement-details'
import type { SettlementDetailFilters, SettlementSegmentFilters } from '@/lib/inventory/settlement-detail-types'
import type { ExportBatchOptions } from '@/lib/export-pagination'
import { withPermission } from '@/lib/with-permission'

// lib 侧的 listInventorySettlements 自身也是 withPermission 包装（session 由它自己的 HOF 注入），
// 这里只转发业务参数。
export const listInventorySettlements = withPermission(
  'inventory:list',
  async (_session, filters: { startDate?: string; endDate?: string; market?: string } = {}) =>
    listInventorySettlementsImpl(filters),
)

/** 下钻某个汇总行的明细（#349）：两个端点必填，与汇总行同源同口径。 */
export const listSettlementDetails = withPermission(
  'inventory:list',
  async (session, filters: SettlementDetailFilters) => listSettlementDetailsForSession(session, filters),
)

/** 整段导出（#349）：走 worker 注入的会话，段不可见时取数侧返回空集。 */
export const exportSettlementSegmentDetails = withPermission(
  'inventory:export',
  async (session, filters: SettlementSegmentFilters = {}, options?: ExportBatchOptions<string>) =>
    exportSettlementSegmentDetailsForSession(session, filters, options),
)
