import { notFound } from "next/navigation"
import { getMerchantById } from "@/actions/merchants"
import { getSession } from "@/lib/auth"
import { isAdminScope } from "@/lib/permissions"
import { hasUiCapability } from '@/lib/permission-contract'
import { requireUiPageCapability } from '@/lib/page-capability'
import MerchantDetailPage from "../_components/merchant-detail-page"

export const dynamic = "force-dynamic"

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await getSession()
  requireUiPageCapability(session, 'merchant:list')
  const actions = session?.permissions.actions ?? []
  const canEdit = hasUiCapability(actions, "merchant:update")
  const canDelete = !!(session && hasUiCapability(actions, 'merchant:delete') && isAdminScope(session))

  const merchant = await getMerchantById(id)
  if (!merchant) notFound()

  return <MerchantDetailPage merchant={merchant} canEdit={canEdit} canDelete={canDelete} />
}
