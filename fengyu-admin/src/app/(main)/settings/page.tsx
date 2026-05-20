import SettingsPageClient from './_components/settings-page'
import { getSettings, getRechargeCardConfig } from '@/actions/settings'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [settings, rechargeCardConfig] = await Promise.all([
    getSettings(),
    getRechargeCardConfig(),
  ])
  return <SettingsPageClient initialSettings={settings} rechargeCardConfig={rechargeCardConfig} />
}
