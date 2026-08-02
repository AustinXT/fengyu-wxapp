import { Suspense } from 'react'
import {
  listSaleOrders,
  createSaleOrder,
  deleteSaleOrder,
} from '@/actions/inventory/sale'
import { getMarketStoreFilterOptions } from '@/actions/stores'
import { getSession } from '@/lib/auth'
import { hasPermission, isAdminScope } from '@/lib/permissions'
import InventoryListView from '../_components/inventory-list-view'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const [{ data, total }, filterOptions, session] = await Promise.all([
    listSaleOrders({
      marketId: params.market,
      storeId: params.store,
      docSubtype: params.subtype,
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

  const canCreate = session ? hasPermission(session, 'inventory:create') : false
  const canDelete = session ? isAdminScope(session) : false

  return (
    <div className="p-6">
      <Suspense>
        <InventoryListView
          category="sale"
          title="销售出库（销售出库 / 顾客退货）"
          rows={data}
          total={total}
          filterOptions={filterOptions}
          canCreate={canCreate}
          canDelete={canDelete}
          onCreate={createSaleOrder}
          onDelete={deleteSaleOrder}
        />
      </Suspense>
    </div>
  )
}
