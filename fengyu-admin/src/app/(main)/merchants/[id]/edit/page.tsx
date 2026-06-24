import { notFound } from "next/navigation"
import { getMerchantById } from "@/actions/merchants"
import MerchantForm from "../../_components/merchant-form"

export const dynamic = "force-dynamic"

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const merchant = await getMerchantById(id)
  if (!merchant) notFound()

  return <MerchantForm merchant={merchant} />
}
