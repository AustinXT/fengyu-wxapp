import { Suspense } from 'react'
import { listPendingReceipts, pendingReceiptOptions } from '@/actions/inventory/pending-receipts'
import { getSession } from '@/lib/auth'
import { ApiError } from '@/lib/api-error'
import { requireAllUiPageCapabilities } from '@/lib/page-capability'
import { hasUiCapability } from '@/lib/permission-contract'
import type { PendingReceiptPage } from '@/lib/inventory/pending-receipt-types'
import PendingReceiptsPage from '../_components/pending-receipts-page'

export const dynamic = 'force-dynamic'
const QUERY_KEYS = ['kind', 'market', 'store', 'start', 'end', 'page', 'size'] as const

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await getSession()
  requireAllUiPageCapabilities(session, ['inventory:list'])
  const raw = await searchParams
  const duplicated = QUERY_KEYS.some(key => Array.isArray(raw[key]))
  const params = Object.fromEntries(QUERY_KEYS.map(key => [key, Array.isArray(raw[key]) ? undefined : raw[key]])) as Record<(typeof QUERY_KEYS)[number], string | undefined>
  const kind = params.kind === 'market' ? 'market' : 'store'
  const options = await pendingReceiptOptions(kind)
  let result: PendingReceiptPage = { rows: [], total: 0, page: 1, pageSize: 20 }
  let error: string | null = duplicated ? '查询参数重复，请重新选择条件' : null
  if (!duplicated) {
    try {
      result = await listPendingReceipts(params)
    } catch (err) {
      if (!(err instanceof ApiError) || err.prefix !== 'INVALID_PARAMS') throw err
      error = err.message.replace(/^INVALID_PARAMS:\s*/, '')
    }
  }
  return <div className="p-6"><Suspense><PendingReceiptsPage result={result} kind={kind} options={options} error={error} canExport={hasUiCapability(session.permissions.actions, 'inventory:export')} /></Suspense></div>
}
