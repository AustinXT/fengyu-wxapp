import SettingsPageClient from './_components/settings-page'
import { getSettings } from '@/actions/settings'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const settings = await getSettings()
  return <SettingsPageClient initialSettings={settings} />
}
