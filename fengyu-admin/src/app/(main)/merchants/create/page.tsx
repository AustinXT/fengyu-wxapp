import { notFound } from "next/navigation"
import { getSession } from "@/lib/auth"
import { hasPermission } from "@/lib/permissions"
import { getMerchantMarketOptions } from "@/actions/merchants"
import MerchantForm from "../_components/merchant-form"

export const dynamic = "force-dynamic"

export default async function Page() {
  
  const session = await getSession()
  if (!session || !hasPermission(session, "merchant:create")) notFound()
  const markets = await getMerchantMarketOptions()
  return <MerchantForm markets={markets} />
}
