import SettingsPageClient from './_components/settings-page'
import { getSettings, getRechargeCardConfig, getConsumeAgreement } from '@/actions/settings'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [settings, rechargeCardConfig, consumeAgreement] = await Promise.all([
    getSettings(),
    getRechargeCardConfig(),
    getConsumeAgreement(),
  ])
  return (
    <SettingsPageClient
      initialSettings={settings}
      rechargeCardConfig={rechargeCardConfig}
      consumeAgreement={consumeAgreement}
    />
  )
}
