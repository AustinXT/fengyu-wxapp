import { Suspense } from 'react'
import {
  listInventorySkuCompositionOptions,
  listInventorySkuCompositions,
} from '@/actions/inventory/mappings'
import { getSession } from '@/lib/auth'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireAllUiPageCapabilities } from '@/lib/page-capability'
import InventorySkuMappingsPage from '../_components/inventory-sku-mappings-page'
import { InventoryMasterDataTabs } from '../_components/inventory-master-data-tabs'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const status = ['configured', 'unconfigured', 'invalid'].includes(params.status ?? '')
    ? params.status as 'configured' | 'unconfigured' | 'invalid'
    : undefined
  const page = params.page ? Number(params.page) : 1
  const pageSize = params.size ? Number(params.size) : 20
  const session = await getSession()
  requireAllUiPageCapabilities(session, ['inventory:stock_list'])
  const [compositions, options] = await Promise.all([
    listInventorySkuCompositions({ keyword: params.q, status, page, pageSize }),
    listInventorySkuCompositionOptions(),
  ])
  const canCreate = hasUiCapability(session.permissions.actions, 'inventory:supply_chain_master_data_manage')
  const canUpdate = canCreate

  return (
    <div className="p-6">
      <InventoryMasterDataTabs />
      <Suspense>
        <InventorySkuMappingsPage
          rows={compositions.data}
          total={compositions.total}
          options={options}
          canCreate={canCreate}
          canUpdate={canUpdate}
        />
      </Suspense>
    </div>
  )
}
