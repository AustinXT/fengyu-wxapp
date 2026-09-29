'use server'

import { withPermission } from '@/lib/with-permission'
import { exportPendingReceiptsForSession, listPendingReceiptsForSession, pendingReceiptOptionsForSession } from '@/lib/inventory/pending-receipts'
import type { PendingReceiptFilters } from '@/lib/inventory/pending-receipt-types'
import type { ExportBatchOptions } from '@/lib/export-pagination'

export const listPendingReceipts = withPermission('inventory:list', async (session, params: PendingReceiptFilters & { page?: unknown; size?: unknown }) => listPendingReceiptsForSession(session, params))
export const pendingReceiptOptions = withPermission('inventory:list', async (session, kind?: string) => pendingReceiptOptionsForSession(session, kind))
export const exportPendingReceipts = withPermission('inventory:export', async (session, params: PendingReceiptFilters = {}, options?: ExportBatchOptions<string>) => exportPendingReceiptsForSession(session, params, options))
