import { getRates, getMarkets } from '@/actions/commission'
import CommissionPage from './_components/commission-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [rates, markets] = await Promise.all([getRates(), getMarkets()])
  return <CommissionPage rates={rates} markets={markets} />
}
