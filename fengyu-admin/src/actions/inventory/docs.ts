'use server'

import {
  approveInventoryCoreDoc as approveInventoryCoreDocImpl,
  confirmInventoryCoreReceive as confirmInventoryCoreReceiveImpl,
  createInventoryCoreDoc as createInventoryCoreDocImpl,
  getInventoryCoreDocById as getInventoryCoreDocByIdImpl,
  listInventoryCoreDocs as listInventoryCoreDocsImpl,
  rejectInventoryCoreDoc as rejectInventoryCoreDocImpl,
} from '@/lib/inventory/engine'
import type { CreateInventoryDocInput, InventoryCoreDocStatus, InventoryDocType, InventoryLocationType } from '@/lib/inventory/types'
import {
  INVENTORY_OPERATION_DOC_QUERY,
  type InventoryOperationDocQuery,
} from '@/lib/inventory/operation-doc-types'
import { ApiError } from '@/lib/api-error'
import { withAnyPermission, withPermission } from '@/lib/with-permission'

export const listInventoryCoreDocs = withPermission(
  'inventory:list',
  async (
    _session,
    filters: {
      orgNodeId?: string
      locationType?: InventoryLocationType
      docType?: InventoryDocType
      status?: InventoryCoreDocStatus
      startDate?: string
      endDate?: string
      keyword?: string
      page?: number
      pageSize?: number
    } = {},
  ) => listInventoryCoreDocsImpl(filters),
)

/**
 * 办理台业务工作区「单据」Tab 的数据源（#190）。
 *
 * 客户端只传业务卡片 id，**单据类型 / 状态 / 层级收窄一律在服务端查映射表解析** ——
 * 不让客户端直接指定 docType，省得日后有人从这个入口拼出一份绕过办理台语义的查询。
 * 可见范围完全沿用 `listInventoryCoreDocs` 的 scope 过滤，不另起一套口径。
 */
export const listInventoryOperationDocs = withPermission(
  'inventory:list',
  async (_session, input: { operationId: string; page?: number; pageSize?: number }) => {
    const query = (INVENTORY_OPERATION_DOC_QUERY as Record<string, InventoryOperationDocQuery | undefined>)[
      input.operationId
    ]
    if (!query) throw new ApiError('INVALID_PARAMS', '未知的库存业务')
    return listInventoryCoreDocsImpl({
      docTypes: query.docTypes,
      statuses: query.statuses,
      locationType: query.locationType,
      cancellationRequested: query.cancellationRequested,
      page: input.page,
      pageSize: input.pageSize,
    })
  },
)

export const getInventoryCoreDocById = withPermission(
  'inventory:list',
  async (_session, id: string) => getInventoryCoreDocByIdImpl(id),
)

export const createInventoryCoreDoc = withAnyPermission(
  ['inventory:supply_chain_operate', 'inventory:market_operate', 'inventory:store_operate'],
  async (_session, input: CreateInventoryDocInput) => createInventoryCoreDocImpl(input),
)

export const approveInventoryCoreDoc = withAnyPermission(
  ['inventory:supply_chain_approve', 'inventory:market_approve'],
  async (_session, id: string, auditRemark?: string | null) =>
    approveInventoryCoreDocImpl(id, auditRemark),
)

export const rejectInventoryCoreDoc = withAnyPermission(
  ['inventory:supply_chain_approve', 'inventory:market_approve'],
  async (_session, id: string, auditRemark?: string | null) =>
    rejectInventoryCoreDocImpl(id, auditRemark),
)

export const confirmInventoryCoreReceive = withAnyPermission(
  ['inventory:market_operate', 'inventory:store_operate'],
  async (_session, outboundDocId: string, remark?: string | null) =>
    confirmInventoryCoreReceiveImpl(outboundDocId, remark),
)
