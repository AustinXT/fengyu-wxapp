import { Suspense } from 'react'
import { getLogs } from '@/actions/logs'
import { getSession } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import LogsPage from './_components/logs-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [logs, session] = await Promise.all([getLogs(), getSession()])
  const canDelete = session ? hasPermission(session, 'operation_log:delete') : false
  return (
    <Suspense>
      <LogsPage logs={logs} canDelete={canDelete} />
    </Suspense>
  )
}
