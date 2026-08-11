import { Suspense } from 'react'
import {
  listScrapOrders,
  createScrapOrder,
  deleteScrapOrder,
} from '@/actions/inventory/scrap'
import { getMarketStoreFilterOptions } from '@/actions/stores'
import { getSession } from '@/lib/auth'
import { isAdminScope } from '@/lib/permissions'
import { hasUiCapability } from '@/lib/permission-contract'
import InventoryListView from '../_components/inventory-list-view'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const [{ data, total }, filterOptions, session] = await Promise.all([
    listScrapOrders({
      marketId: params.market,
      storeId: params.store,
      status: params.status as '草稿' | '已完成' | '已取消' | undefined,
      startDate: params.from,
      endDate: params.to,
      search: params.q,
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getMarketStoreFilterOptions(),
    getSession(),
  ])

  const actions = session?.permissions.actions ?? []
  const canCreate = hasUiCapability(actions, 'inventory:create')
  const canDelete = !!(session && hasUiCapability(actions, 'inventory:delete') && isAdminScope(session))

  return (
    <div className="p-6">
      <Suspense>
        <InventoryListView
          category="scrap"
          title="报损出库（产品损耗 / 异常处理）"
          rows={data}
          total={total}
          filterOptions={filterOptions}
          canCreate={canCreate}
          canDelete={canDelete}
          onCreate={createScrapOrder}
          onDelete={deleteScrapOrder}
        />
      </Suspense>
    </div>
  )
}
