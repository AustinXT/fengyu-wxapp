import { Suspense } from 'react'
import { getLogsPaginated } from '@/actions/logs'
import { getMarketStoreFilterOptions } from '@/actions/stores'
import { getSession } from '@/lib/auth'
import { isAdminScope } from '@/lib/permissions'
import { hasUiCapability } from '@/lib/permission-contract'
import LogsPage from './_components/logs-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const [{ data: logs, total }, session, filterOptions] = await Promise.all([
    getLogsPaginated({
      operatorName: params.q,
      action: params.action,
      targetType: params.target,
      marketId: params.market,
      storeId: params.store,
      startDate: params.from,
      endDate: params.to,
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getSession(),
    getMarketStoreFilterOptions(),
  ])
  const canDelete = !!(session && hasUiCapability(session.permissions.actions, 'operation_log:delete') && isAdminScope(session))
  return (
    <Suspense>
      <LogsPage logs={logs} total={total} canDelete={canDelete} filterOptions={filterOptions} />
    </Suspense>
  )
}
