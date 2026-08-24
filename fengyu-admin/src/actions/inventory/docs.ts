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
import { withPermission } from '@/lib/with-permission'

export const listInventoryCoreDocs = withPermission(
  'inventory:list',
  async (
    _session,
    filters: {
      locationId?: string
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

export const getInventoryCoreDocById = withPermission(
  'inventory:list',
  async (_session, id: string) => getInventoryCoreDocByIdImpl(id),
)

export const createInventoryCoreDoc = withPermission(
  'inventory:create_doc',
  async (_session, input: CreateInventoryDocInput) => createInventoryCoreDocImpl(input),
)

export const approveInventoryCoreDoc = withPermission(
  'inventory:approve',
  async (_session, id: string, auditRemark?: string | null) =>
    approveInventoryCoreDocImpl(id, auditRemark),
)

export const rejectInventoryCoreDoc = withPermission(
  'inventory:approve',
  async (_session, id: string, auditRemark?: string | null) =>
    rejectInventoryCoreDocImpl(id, auditRemark),
)

export const confirmInventoryCoreReceive = withPermission(
  'inventory:create_doc',
  async (_session, outboundDocId: string, remark?: string | null) =>
    confirmInventoryCoreReceiveImpl(outboundDocId, remark),
)
