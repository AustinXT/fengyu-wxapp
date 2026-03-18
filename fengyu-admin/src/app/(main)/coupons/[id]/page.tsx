import { notFound } from "next/navigation"
import { getTemplateById, getMarkets } from "@/actions/coupons"
import CouponDetailPage from "../_components/coupon-detail-page"

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [template, markets] = await Promise.all([getTemplateById(id), getMarkets()])
  if (!template) notFound()
  return <CouponDetailPage template={template} markets={markets} />
}
