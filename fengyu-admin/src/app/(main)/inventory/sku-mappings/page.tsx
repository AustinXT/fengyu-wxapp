import { Suspense } from 'react'
import {
  listInventorySkuMappingOptions,
  listInventorySkuMappings,
} from '@/actions/inventory/mappings'
import { getSession } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import InventorySkuMappingsPage from '../_components/inventory-sku-mappings-page'

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
  const [rows, options, session] = await Promise.all([
    listInventorySkuMappings({ keyword: params.q, onlyActive }),
    listInventorySkuMappingOptions(),
    getSession(),
  ])
  const canCreate = session ? hasPermission(session, 'inventory:create') : false
  const canUpdate = session ? hasPermission(session, 'inventory:update') : false

  return (
    <div className="p-6">
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
