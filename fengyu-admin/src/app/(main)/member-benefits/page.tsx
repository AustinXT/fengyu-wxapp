import MemberBenefitsPageClient from './_components/member-benefits-page'
import { getMemberBenefits, listActiveCouponTemplates } from '@/actions/settings'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [bundle, couponTemplates] = await Promise.all([
    getMemberBenefits(),
    listActiveCouponTemplates(),
  ])
  return <MemberBenefitsPageClient initialBundle={bundle} couponTemplates={couponTemplates} />
}
