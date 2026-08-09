import { Suspense } from 'react'
import { listInventorySuppliers } from '@/actions/inventory/suppliers'
import { getSession } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import InventorySuppliersPage from '../_components/inventory-suppliers-page'

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
  const [rows, session] = await Promise.all([
    listInventorySuppliers({ keyword: params.q, onlyActive }),
    getSession(),
  ])
  const canCreate = session ? hasPermission(session, 'inventory:create') : false
  const canUpdate = session ? hasPermission(session, 'inventory:update') : false

  return (
    <div className="p-6">
      <Suspense>
        <InventorySuppliersPage rows={rows} canCreate={canCreate} canUpdate={canUpdate} />
      </Suspense>
    </div>
  )
}
