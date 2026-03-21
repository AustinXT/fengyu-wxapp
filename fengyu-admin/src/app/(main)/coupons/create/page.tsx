import { getMarkets } from "@/actions/coupons"
import CouponCreatePage from "../_components/coupon-create-page"

export const dynamic = 'force-dynamic'

export default async function Page() {
  const markets = await getMarkets()
  return <CouponCreatePage markets={markets} />
}
