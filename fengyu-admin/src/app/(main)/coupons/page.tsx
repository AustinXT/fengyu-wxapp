import { Suspense } from 'react'
import { getTemplates, getMarkets } from '@/actions/coupons'
import CouponsPage from './_components/coupons-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [templates, markets] = await Promise.all([getTemplates(), getMarkets()])
  return (
    <Suspense>
      <CouponsPage templates={templates} markets={markets} />
    </Suspense>
  )
}
