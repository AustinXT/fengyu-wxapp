import { Suspense } from 'react'
import { getLogs } from '@/actions/logs'
import { getSession } from '@/lib/auth'
import { isAdminScope } from '@/lib/permissions'
import LogsPage from './_components/logs-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [logs, session] = await Promise.all([getLogs(), getSession()])
  const canDelete = session ? isAdminScope(session) : false
  return (
    <Suspense>
      <LogsPage logs={logs} canDelete={canDelete} />
    </Suspense>
  )
}
