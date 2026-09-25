import { Suspense } from 'react'
import { listInventoryLocationFilterOptions } from '@/actions/inventory/locations'
import { listInventoryMovements } from '@/actions/inventory/movements'
import { ApiError } from '@/lib/api-error'
import { getSession } from '@/lib/auth'
import { resolveInventoryFilterLocationId } from '@/lib/inventory/location-filter'
import type { InventoryMovementPage } from '@/lib/inventory/types'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireAllUiPageCapabilities } from '@/lib/page-capability'
import InventoryMovementsPage from '../_components/inventory-movements-page'

export const dynamic = 'force-dynamic'

const EMPTY_PAGE: InventoryMovementPage = { rows: [], total: 0, hasPrev: false, hasNext: false }

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const session = await getSession()
  requireAllUiPageCapabilities(session, ['inventory:stock_list'])
  const filterOptions = await listInventoryLocationFilterOptions()
  const selectedLocationId = resolveInventoryFilterLocationId(filterOptions, params.location)
  const hasQuery = Boolean(params.sku?.trim() || params.batch?.trim())

  let result = EMPTY_PAGE
  let errorMessage: string | null = null
  if (selectedLocationId && hasQuery) {
    try {
      result = await listInventoryMovements({
        locationId: selectedLocationId,
        skuCode: params.sku,
        batchNo: params.batch,
        startDate: params.start,
        endDate: params.end,
        after: params.after,
        before: params.before,
        pageSize: params.size ? Number(params.size) : undefined,
      })
    } catch (err) {
      // 手改 URL 造出的非法入参（假日期、二选一都填）给可读提示，不让整页 500
      if (!(err instanceof ApiError) || err.prefix !== 'INVALID_PARAMS') throw err
      errorMessage = err.message.replace(/^INVALID_PARAMS:\s*/, '')
    }
  }

  return (
    <div className="p-6">
      <Suspense>
        <InventoryMovementsPage
          page={result}
          hasQuery={hasQuery}
          errorMessage={errorMessage}
          canExport={hasUiCapability(session.permissions.actions, 'inventory:export')}
          // 单号跳转沿用单据详情页自己的闸门（inventory:list + 单据可见性），没有就只显示纯文本
          canOpenDoc={hasUiCapability(session.permissions.actions, 'inventory:list')}
          locationFilterOptions={filterOptions}
          selectedLocationId={selectedLocationId}
        />
      </Suspense>
    </div>
  )
}
