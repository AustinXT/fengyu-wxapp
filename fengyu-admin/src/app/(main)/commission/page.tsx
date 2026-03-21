import { Suspense } from 'react'
import { getRates, getMarkets } from '@/actions/commission'
import CommissionPage from './_components/commission-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [rates, markets] = await Promise.all([getRates(), getMarkets()])
  return (
    <Suspense>
      <CommissionPage rates={rates} markets={markets} />
    </Suspense>
  )
}
