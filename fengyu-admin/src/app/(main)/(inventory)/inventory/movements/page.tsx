import { Suspense } from 'react'
import { listInventoryMovementLocationFilterOptions } from '@/actions/inventory/locations'
import { listInventoryMovements } from '@/actions/inventory/movements'
import { ApiError } from '@/lib/api-error'
import { getSession } from '@/lib/auth'
import { resolveInventoryFilterLocationId } from '@/lib/inventory/location-filter'
import type { InventoryMovementPage } from '@/lib/inventory/types'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireAllUiPageCapabilities } from '@/lib/page-capability'
import InventoryMovementsPage from '../_components/inventory-movements-page'

export const dynamic = 'force-dynamic'

/**
 * 本页从 URL 消费的全部键。`params` 只由这些键构造（类型为 Record<QueryKey, …>），
 * 读一个没登记的键是类型错误 —— 新增筛选参数必须先加进这里，重复检测随之覆盖。
 */
const QUERY_KEYS = ['location', 'sku', 'batch', 'start', 'end', 'after', 'before', 'size'] as const
type QueryKey = (typeof QUERY_KEYS)[number]

const EMPTY_PAGE: InventoryMovementPage = { rows: [], total: 0, hasPrev: false, hasNext: false }

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const raw = await searchParams
  // 同名参数重复（?sku=A&sku=B）时 Next 给数组：不猜取哪个，按非法条件提示。
  // 只看本页消费的键 —— 跟踪参数 / returnTo 之类重复不该挡住查询
  const duplicated = QUERY_KEYS.some((key) => Array.isArray(raw[key]))
  const params = Object.fromEntries(
    QUERY_KEYS.map((key) => {
      const value = raw[key]
      return [key, Array.isArray(value) ? undefined : value]
    }),
  ) as Record<QueryKey, string | undefined>
  const session = await getSession()
  requireAllUiPageCapabilities(session, ['inventory:stock_list'])
  const filterOptions = await listInventoryMovementLocationFilterOptions()
  const selectedLocationId = resolveInventoryFilterLocationId(filterOptions, params.location)
  const hasQuery = Boolean(params.sku?.trim() || params.batch?.trim())

  let result = EMPTY_PAGE
  let errorMessage: string | null = duplicated ? '查询参数重复，请重新输入条件查询' : null
  if (selectedLocationId && hasQuery && !duplicated) {
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
          // 输入框 / 查询方式是本地 state：前进后退、菜单软导航改了 sku|batch 时重挂载，别让输入框与表格对不上
          key={`${params.sku ?? ''}|${params.batch ?? ''}`}
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
