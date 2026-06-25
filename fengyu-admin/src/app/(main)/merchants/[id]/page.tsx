import { notFound } from "next/navigation"
import { getMerchantById } from "@/actions/merchants"
import { getSession } from "@/lib/auth"
import { hasPermission } from "@/lib/permissions"
import MerchantDetailPage from "../_components/merchant-detail-page"

export const dynamic = "force-dynamic"

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await getSession()
  const canEdit = !!(session && hasPermission(session, "merchant:update"))
  const canDelete = !!(session && hasPermission(session, "merchant:delete"))

  const merchant = await getMerchantById(id)
  if (!merchant) notFound()

  return <MerchantDetailPage merchant={merchant} canEdit={canEdit} canDelete={canDelete} />
}
