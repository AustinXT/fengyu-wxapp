import { getRates } from '@/actions/commission'
import CommissionPage from './_components/commission-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const rates = await getRates()
  return <CommissionPage rates={rates} />
}
