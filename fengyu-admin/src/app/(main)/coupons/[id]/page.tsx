import { notFound } from "next/navigation"
import { getTemplateById, getMarkets, getIssuedCoupons, getCategoriesForCoupon } from "@/actions/coupons"
import { getSession } from '@/lib/auth'
import { requireUiPageCapability } from '@/lib/page-capability'
import { hasUiCapability } from '@/lib/permission-contract'
import CouponDetailPage from "../_components/coupon-detail-page"

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await getSession()
  requireUiPageCapability(session, 'coupon:list')
  const actions = session.permissions.actions
  const [template, markets, issuedCoupons, categories] = await Promise.all([
    getTemplateById(id),
    getMarkets(),
    getIssuedCoupons(id),
    getCategoriesForCoupon(),
  ])
  if (!template) notFound()
  return (
    <CouponDetailPage
      template={template}
      markets={markets}
      issuedCoupons={issuedCoupons}
      categories={categories}
      canCreate={hasUiCapability(actions, 'coupon:create')}
      canUpdate={hasUiCapability(actions, 'coupon:update')}
    />
  )
}
