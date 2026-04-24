import ShareGiftPageClient from './_components/share-gift-page'
import { getShareGiftConfig, listActiveCouponTemplates } from '@/actions/settings'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [config, couponTemplates] = await Promise.all([
    getShareGiftConfig(),
    listActiveCouponTemplates(),
  ])
  return <ShareGiftPageClient initialConfig={config} couponTemplates={couponTemplates} />
}
