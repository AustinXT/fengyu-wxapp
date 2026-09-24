import { getMarkets, getCategoriesForCoupon } from "@/actions/coupons"
import { getSession } from '@/lib/auth'
import { requireUiPageCapability } from '@/lib/page-capability'
import CouponCreatePage from "../_components/coupon-create-page"

export const dynamic = 'force-dynamic'

export default async function Page() {
  requireUiPageCapability(await getSession(), 'coupon:create')
  const [markets, categories] = await Promise.all([getMarkets(), getCategoriesForCoupon()])
  return <CouponCreatePage markets={markets} categories={categories} />
}
