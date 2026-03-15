import { Suspense } from 'react'
import { getTemplates } from '@/actions/coupons'
import CouponsPage from './_components/coupons-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const templates = await getTemplates()
  return (
    <Suspense>
      <CouponsPage templates={templates} />
    </Suspense>
  )
}
