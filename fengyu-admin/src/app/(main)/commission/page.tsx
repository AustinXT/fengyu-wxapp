import { Suspense } from 'react'
import { getRates, getMarkets } from '@/actions/commission'
import { getActiveSkillTags } from '@/actions/skill-tags'
import CommissionPage from './_components/commission-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [rates, markets, skillTags] = await Promise.all([getRates(), getMarkets(), getActiveSkillTags()])
  return (
    <Suspense>
      <CommissionPage rates={rates} markets={markets} skillTags={skillTags} />
    </Suspense>
  )
}
