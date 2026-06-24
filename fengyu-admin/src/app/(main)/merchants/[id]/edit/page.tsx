import { notFound } from "next/navigation"
import { getMerchantById, getMerchantMarketOptions } from "@/actions/merchants"
import MerchantForm from "../../_components/merchant-form"

export const dynamic = "force-dynamic"

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [merchant, markets] = await Promise.all([
    getMerchantById(id),
    getMerchantMarketOptions(),
  ])
  if (!merchant) notFound()

  return <MerchantForm merchant={merchant} markets={markets} />
}
