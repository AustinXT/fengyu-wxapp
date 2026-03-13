import { notFound } from "next/navigation"
import { getTemplateById } from "@/actions/coupons"
import CouponDetailPage from "../_components/coupon-detail-page"

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const template = await getTemplateById(id)
  if (!template) notFound()
  return <CouponDetailPage template={template} />
}
