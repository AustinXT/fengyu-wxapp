import { Suspense } from 'react'
import { getRates, getMarkets } from '@/actions/commission'
import { getSkillTags } from '@/actions/skill-tags'
import { getSession } from '@/lib/auth'
import { hasPermission, isAdminScope } from '@/lib/permissions'
import { hasUiCapability } from '@/lib/permission-contract'
import CommissionPage from './_components/commission-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const session = await getSession()
  const actions = session?.permissions.actions ?? []
  const canCreate = hasUiCapability(actions, 'commission:create')
  const canUpdate = hasUiCapability(actions, 'commission:update')
  const canDelete = !!(session && hasUiCapability(actions, 'commission:delete') && isAdminScope(session))
  const canReadSkillTags = !!session && hasPermission(session, 'employee:list')
  const [rates, markets, skillTags] = await Promise.all([
    getRates(),
    getMarkets(),
    canReadSkillTags ? getSkillTags() : Promise.resolve([]),
  ])
  return (
    <Suspense>
      <CommissionPage
        rates={rates}
        markets={markets}
        skillTags={skillTags}
        canCreate={canCreate}
        canUpdate={canUpdate}
        canDelete={canDelete}
      />
    </Suspense>
  )
}
