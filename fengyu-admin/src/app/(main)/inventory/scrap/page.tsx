import { Suspense } from 'react'
import {
  listScrapOrders,
  createScrapOrder,
  deleteScrapOrder,
} from '@/actions/inventory/scrap'
import { getStores } from '@/actions/stores'
import { getSession } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import InventoryListView from '../_components/inventory-list-view'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const [{ data, total }, stores, session] = await Promise.all([
    listScrapOrders({
      storeId: params.store,
      status: params.status as '草稿' | '已完成' | '已取消' | undefined,
      startDate: params.from,
      endDate: params.to,
      search: params.q,
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getStores(),
    getSession(),
  ])

  const canCreate = session ? hasPermission(session, 'inventory:create') : false
  const canDelete = session ? hasPermission(session, 'inventory:delete') : false

  return (
    <div className="p-6">
      <Suspense>
        <InventoryListView
          category="scrap"
          title="报损出库（产品损耗 / 异常处理）"
          rows={data}
          total={total}
          stores={stores.map((s) => ({ storeId: s.storeId, storeName: s.storeName }))}
          canCreate={canCreate}
          canDelete={canDelete}
          onCreate={createScrapOrder}
          onDelete={deleteScrapOrder}
        />
      </Suspense>
    </div>
  )
}
