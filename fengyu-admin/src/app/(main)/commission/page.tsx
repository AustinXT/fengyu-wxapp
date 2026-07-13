import { Suspense } from 'react'
import { getRates, getMarkets } from '@/actions/commission'
import { getActiveSkillTags } from '@/actions/skill-tags'
import { getSession } from '@/lib/auth'
import { isAdminScope } from '@/lib/permissions'
import CommissionPage from './_components/commission-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [rates, markets, skillTags, session] = await Promise.all([getRates(), getMarkets(), getActiveSkillTags(), getSession()])
  const canDelete = !!session && isAdminScope(session)
  return (
    <Suspense>
      <CommissionPage rates={rates} markets={markets} skillTags={skillTags} canDelete={canDelete} />
    </Suspense>
  )
}
