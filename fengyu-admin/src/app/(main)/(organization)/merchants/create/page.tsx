import { notFound } from "next/navigation"
import { getSession } from "@/lib/auth"
import { requireUiPageCapability } from '@/lib/page-capability'
import { getMerchantMarketOptions } from "@/actions/merchants"
import MerchantForm from "../_components/merchant-form"

export const dynamic = "force-dynamic"

export default async function Page() {
  requireUiPageCapability(await getSession(), 'merchant:create')
  const markets = await getMerchantMarketOptions()
  return <MerchantForm markets={markets} />
}
