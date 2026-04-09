import SettingsPageClient from './_components/settings-page'
import { getSettings, listActiveCouponTemplates } from '@/actions/settings'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [settings, couponTemplates] = await Promise.all([
    getSettings(),
    listActiveCouponTemplates(),
  ])
  return <SettingsPageClient initialSettings={settings} couponTemplates={couponTemplates} />
}
