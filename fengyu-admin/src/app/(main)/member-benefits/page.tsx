import MemberBenefitsPageClient from './_components/member-benefits-page'
import { getMemberBenefits, getShareGiftConfig, listActiveCouponTemplates } from '@/actions/settings'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [bundle, shareConfig, couponTemplates] = await Promise.all([
    getMemberBenefits(),
    getShareGiftConfig(),
    listActiveCouponTemplates(),
  ])
  return (
    <MemberBenefitsPageClient
      initialBundle={bundle}
      initialShareConfig={shareConfig}
      couponTemplates={couponTemplates}
    />
  )
}
