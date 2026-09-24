import { getLakalaDiagnostics } from '@/actions/lakala-diagnostics'
import { getDatabaseBackupOverview, getSystemDiagnostics } from '@/actions/system-diagnostics'
import { DiagnosticsPage } from './_components/diagnostics-page'

export const dynamic = 'force-dynamic'

export default async function SystemDiagnosticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const activeTab = params.tab === 'lakala' ? 'lakala' : 'subsystems'
  const [system, backups, lakala] = await Promise.all([
    getSystemDiagnostics(),
    getDatabaseBackupOverview(),
    getLakalaDiagnostics(),
  ])
  return (
    <DiagnosticsPage
      initialTab={activeTab}
      initialSystem={system}
      initialBackups={backups}
      initialLakala={lakala}
    />
  )
}
