import { Suspense } from 'react'
import { getLogsPaginated } from '@/actions/logs'
import { getSession } from '@/lib/auth'
import { isAdminScope } from '@/lib/permissions'
import LogsPage from './_components/logs-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const [{ data: logs, total }, session] = await Promise.all([
    getLogsPaginated({
      operatorName: params.q,
      action: params.action,
      targetType: params.target,
      startDate: params.from,
      endDate: params.to,
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getSession(),
  ])
  const canDelete = session ? isAdminScope(session) : false
  return (
    <Suspense>
      <LogsPage logs={logs} total={total} canDelete={canDelete} />
    </Suspense>
  )
}
