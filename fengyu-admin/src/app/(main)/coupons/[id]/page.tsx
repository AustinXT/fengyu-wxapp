import { notFound } from "next/navigation"
import { getTemplateById, getMarkets, getIssuedCoupons, getCategoriesForCoupon } from "@/actions/coupons"
import CouponDetailPage from "../_components/coupon-detail-page"

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [template, markets, issuedCoupons, categories] = await Promise.all([
    getTemplateById(id),
    getMarkets(),
    getIssuedCoupons(id),
    getCategoriesForCoupon(),
  ])
  if (!template) notFound()
  return <CouponDetailPage template={template} markets={markets} issuedCoupons={issuedCoupons} categories={categories} />
}
