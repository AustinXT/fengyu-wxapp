import { redirect } from 'next/navigation'

export default function LegacyLakalaDiagnosticsPage() {
  redirect('/settings/diagnostics?tab=lakala')
}
