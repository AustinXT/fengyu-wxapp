import { getMarkets, getCategoriesForCoupon } from "@/actions/coupons"
import CouponCreatePage from "../_components/coupon-create-page"

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [markets, categories] = await Promise.all([getMarkets(), getCategoriesForCoupon()])
  return <CouponCreatePage markets={markets} categories={categories} />
}
