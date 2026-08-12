import { Suspense } from 'react'
import {
  listInventorySkuMappingOptions,
  listInventorySkuMappings,
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
  const onlyActive = params.status === 'active'
    ? true
    : params.status === 'inactive'
      ? false
      : undefined
  const session = await getSession()
  requireAllUiPageCapabilities(session, ['inventory:stock_list'])
  const [rows, options] = await Promise.all([
    listInventorySkuMappings({ keyword: params.q, onlyActive }),
    listInventorySkuMappingOptions(),
  ])
  const canCreate = hasUiCapability(session.permissions.actions, 'inventory:create')
  const canUpdate = hasUiCapability(session.permissions.actions, 'inventory:update')

  return (
    <div className="p-6">
      <InventoryMasterDataTabs />
      <Suspense>
        <InventorySkuMappingsPage
          rows={rows}
          options={options}
          canCreate={canCreate}
          canUpdate={canUpdate}
        />
      </Suspense>
    </div>
  )
}
