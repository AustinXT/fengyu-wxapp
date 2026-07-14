import { Suspense } from 'react'
import {
  listProcurementOrders,
  createProcurementOrder,
  deleteProcurementOrder,
} from '@/actions/inventory/procurement'
import { getStores } from '@/actions/stores'
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

  const [{ data, total }, stores, session] = await Promise.all([
    listProcurementOrders({
      storeId: params.store,
      docSubtype: params.subtype,
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
  const canDelete = session ? isAdminScope(session) : false

  return (
    <div className="p-6">
      <Suspense>
        <InventoryListView
          category="procurement"
          title="采购入库（院报货 / 院入库 / 退货出库）"
          rows={data}
          total={total}
          stores={stores.map((s) => ({ storeId: s.storeId, storeName: s.storeName }))}
          canCreate={canCreate}
          canDelete={canDelete}
          onCreate={createProcurementOrder}
          onDelete={deleteProcurementOrder}
        />
      </Suspense>
    </div>
  )
}
