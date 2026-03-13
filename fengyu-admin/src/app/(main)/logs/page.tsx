import { getLogs } from '@/actions/logs'
import LogsPage from './_components/logs-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const logs = await getLogs()
  return <LogsPage logs={logs} />
}
