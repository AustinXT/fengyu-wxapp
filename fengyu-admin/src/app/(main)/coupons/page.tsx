import { Suspense } from 'react'
import { getTemplates, getMarkets } from '@/actions/coupons'
import { getSession } from '@/lib/auth'
import { requireUiPageCapability } from '@/lib/page-capability'
import { hasUiCapability } from '@/lib/permission-contract'
import CouponsPage from './_components/coupons-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const session = await getSession()
  requireUiPageCapability(session, 'coupon:list')
  const [templates, markets] = await Promise.all([getTemplates(), getMarkets()])
  return (
    <Suspense>
      <CouponsPage
        templates={templates}
        markets={markets}
        canCreate={hasUiCapability(session.permissions.actions, 'coupon:create')}
        canUpdate={hasUiCapability(session.permissions.actions, 'coupon:update')}
      />
    </Suspense>
  )
}
